import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { colorToCanvasFilter, layersAt, needsComposite, type MediaLayer } from "../lib/compose";
import { canDecodeExactly, FrameSource, hasWebCodecs } from "../lib/decoder";
import { t } from "../lib/i18n";
import { formatDuration, formatTimecode } from "../lib/probe";
import {
  baseVideoTrack,
  clipEnd,
  endHit,
  isMedia,
  srcOut,
  timelineDuration,
  timeToClip,
  type Clip,
} from "../lib/timeline";
import { useEditor } from "../state/editor";

/**
 * Prévia da timeline montada — **WYSIWYG na v0.3**.
 *
 * ─── Três modos, cada um honesto sobre o que é ───────────────────────────────
 *
 * 1. **PARADO, composição fiel** (o novo da v0.3): o playhead para e a gente
 *    COMPÕE a timeline no canvas — trilhas empilhadas, PiP posicionado, recorte,
 *    opacidade/keyframes, crossfade dissolvendo e o título desenhado como TEXTO
 *    no canvas (não chamando ffmpeg). O que aparece é o que exporta.
 * 2. **PARADO, base só**: sem composição (uma trilha, sem filtro) → o quadro
 *    exato da trilha base, quadro a quadro, como na v0.2.
 * 3. **TOCANDO**: quem manda é o `<video>` (traz áudio e ritmo). Compor N fontes
 *    a 30 fps ao vivo seria decodificar vários filmes ao mesmo tempo — caro e
 *    frágil. Então durante o play mostra a base e AVISA "pause pra ver a
 *    composição". Nunca finge que o play é a composição.
 *
 * **Degradar dizendo a verdade** (o selo): container que o demuxer não abre
 * (mkv/webm/avi) não dá pra compor no canvas → aviso de prévia aproximada. E o
 * ajuste de COR é aproximado no canvas (brilho aditivo vs multiplicativo) — o
 * selo diz isso também. Prometer fidelidade que não se tem é pior que não ter.
 */
export default function Preview() {
  const timeline = useEditor((s) => s.history.present);
  const media = useEditor((s) => s.media);
  const missing = useEditor((s) => s.missing);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const rate = useEditor((s) => s.rate);
  const seek = useEditor((s) => s.seek);
  const setPlaying = useEditor((s) => s.setPlaying);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Um decodificador por arquivo: abrir custa ler o arquivo, não se faz por seta. */
  const sources = useRef<Map<string, FrameSource>>(new Map());
  /** O canvas tem um quadro pintado e válido pro playhead de agora? */
  const [painted, setPainted] = useState(false);

  const track = useMemo(() => baseVideoTrack(timeline), [timeline]);
  const total = useMemo(() => timelineDuration(timeline), [timeline]);

  // A trilha BASE ainda comanda o `<video>` (play + áudio) e o caminho simples.
  const baseHit = useMemo(
    () => timeToClip(track, playhead) ?? (playhead >= total ? endHit(track) : null),
    [track, playhead, total],
  );

  // As CAMADAS da composição no instante atual (no fim, gruda no último quadro).
  const layerT = playhead >= total ? Math.max(0, total - 1) : playhead;
  const layers = useMemo(() => layersAt(timeline, layerT), [timeline, layerT]);
  const composite = needsComposite(layers);

  // Resolução de saída = a do 1º clipe de mídia de vídeo (é "o vídeo" pro
  // usuário). O canvas é pintado nesse tamanho e o CSS encaixa na tela.
  const dims = useMemo(() => targetDims(timeline, media), [timeline, media]);

  // Dá pra compor no canvas? (todos os arquivos ativos são decodificáveis exato)
  const mediaLayers = layers.filter((l): l is MediaLayer => l.kind === "media");
  const allDecodable =
    hasWebCodecs() && mediaLayers.every((l) => !missing.includes(l.clip.path!) && canDecodeExactly(l.clip.path!));

  // `hit` do <video>: só vem de clipe de MÍDIA (o `timeToClip` filtra).
  const hitPath = baseHit?.clip.path ?? "";
  const gone = baseHit ? missing.includes(hitPath) : false;
  const fps = baseHit ? (media[hitPath]?.fps ?? 30) : 30;
  const baseExact = baseHit && !gone ? canDecodeExactly(hitPath) : false;
  const src = baseHit && !gone ? convertFileSrc(hitPath) : "";

  // Modo de pintura do canvas quando PARADO:
  //  - compor (várias camadas/filtros) se der pra decodificar tudo;
  //  - senão, o quadro exato da base (caminho da v0.2).
  const doComposite = !playing && layers.length > 0 && composite && allDecodable;

  // Fecha os decodificadores dos arquivos que saíram da timeline (memória de
  // vídeo fora do alcance do GC).
  useEffect(() => {
    const alive = new Set(
      timeline.tracks.flatMap((tk) => tk.clips.filter(isMedia).map((c) => c.path!)),
    );
    for (const [path, fs] of sources.current) {
      if (!alive.has(path)) {
        fs.dispose();
        sources.current.delete(path);
      }
    }
  }, [timeline]);

  useEffect(() => {
    const map = sources.current;
    return () => {
      for (const fs of map.values()) fs.dispose();
      map.clear();
    };
  }, []);

  /** Pega (ou abre) o decodificador de um arquivo. */
  const sourceFor = (path: string): FrameSource => {
    let fs = sources.current.get(path);
    if (!fs) {
      fs = new FrameSource(convertFileSrc(path));
      sources.current.set(path, fs);
    }
    return fs;
  };

  /* ---------- COMPOSIÇÃO (parado, WYSIWYG) ---------- */

  useEffect(() => {
    if (!doComposite) return;
    let dead = false;

    void (async () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = dims.w;
      canvas.height = dims.h;

      // Decodifica os quadros das camadas de mídia ANTES de pintar, pra a tela
      // não piscar meia-composição enquanto os arquivos respondem em ritmos
      // diferentes. Título não decodifica — é texto.
      const frames = new Map<string, VideoFrame | null>();
      for (const l of layers) {
        if (l.kind !== "media") continue;
        try {
          frames.set(l.clip.id, await sourceFor(l.clip.path!).frameAt(Math.round(l.srcTimeMs * 1000)));
        } catch {
          frames.set(l.clip.id, null);
        }
        if (dead) {
          for (const f of frames.values()) f?.close();
          return;
        }
      }

      // Fundo preto (o buraco entre clipes é preto, como no export).
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, dims.w, dims.h);

      for (const l of layers) {
        if (l.kind === "media") {
          const frame = frames.get(l.clip.id) ?? null;
          if (frame) {
            drawMedia(ctx, frame, l.clip, dims.w, dims.h, l.alpha);
            frame.close();
          }
        } else {
          drawTitle(ctx, l.clip, dims.w, dims.h, l.alpha);
        }
      }
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      if (!dead) setPainted(true);
    })();

    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doComposite, layers, dims.w, dims.h]);

  /* ---------- o quadro exato da BASE (parado, sem composição) ---------- */

  useEffect(() => {
    // Durante o play, ou quando a composição está no comando, este caminho cala.
    if (!baseHit || gone || playing || !baseExact || doComposite) {
      if (!doComposite) setPainted(false);
      return;
    }

    let dead = false;
    const path = baseHit.clip.path!;
    const targetUs = Math.round(baseHit.srcTime * 1000);

    void (async () => {
      let frame: VideoFrame | null = null;
      try {
        frame = await sourceFor(path).frameAt(targetUs);
      } catch {
        frame = null;
      }
      if (dead || !frame) {
        frame?.close();
        if (!dead) setPainted(false);
        return;
      }
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        frame.close();
        return;
      }
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      ctx.drawImage(frame, 0, 0);
      frame.close();
      setPainted(true);
    })();

    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseHit, gone, playing, baseExact, doComposite]);

  /* ---------- o play (o <video> manda) ---------- */

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !baseHit || playing) return;
    const want = baseHit.srcTime / 1000;
    if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want;
  }, [baseHit, playing]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing && !gone && rate > 0) {
      v.playbackRate = rate;
      void v.play().catch(() => setPlaying(false));
    } else {
      v.pause();
    }
  }, [playing, gone, rate, baseHit?.clip.id, setPlaying]);

  // A ré, na mão: o playhead recua no relógio de parede, na velocidade pedida.
  useEffect(() => {
    if (!playing || rate >= 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const s = useEditor.getState();
      const next = s.playhead + dt * s.rate;
      if (next <= 0) {
        s.seek(0);
        s.setPlaying(false);
        return;
      }
      s.seek(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate]);

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || !baseHit || !playing || rate < 0) return;
    const srcMs = v.currentTime * 1000;
    const clipIn = baseHit.clip.srcIn ?? 0;
    const clipOut = srcOut(baseHit.clip);
    if (srcMs >= clipOut - 1) {
      const next = clipEnd(baseHit.clip);
      if (next >= total) {
        setPlaying(false);
        seek(total);
      } else {
        seek(next);
      }
      return;
    }
    // Com velocidade, o tempo de tela anda `1/speed` do tempo-fonte.
    const sp = baseHit.clip.speed ?? 1;
    seek(baseHit.clipStart + (srcMs - clipIn) / (sp > 0 ? sp : 1));
  };

  /** O rodapé conta o que a prévia É — e por que, quando é aproximada. */
  const quality = (() => {
    if (!baseHit && layers.length === 0) return "";
    if (playing) return composite ? t("preview.playApprox") : baseExact ? t("preview.exact") : rough();
    // Parado:
    if (composite) {
      if (!allDecodable) return t("preview.roughContainer"); // não deu pra compor
      return mediaLayers.some((l) => l.approx) ? t("preview.approx") : t("preview.wysiwyg");
    }
    return baseExact ? t("preview.exact") : rough();
  })();

  function rough() {
    return !hasWebCodecs() ? t("preview.roughNoCodecs") : t("preview.roughContainer");
  }

  const showVideo = baseHit && !gone && !doComposite;

  return (
    <div className="card preview-card">
      <div className="card-head">
        <strong>{t("preview.title")}</strong>
        <span className="muted small tabnum">
          {formatTimecode(playhead, fps)} / {formatDuration(total)}
          {playing && rate !== 1 ? ` · ${rate > 0 ? "" : "◀ "}${Math.abs(rate)}×` : ""}
        </span>
      </div>

      <div className="stage">
        {baseHit && !gone ? (
          <>
            <video
              ref={videoRef}
              className="stage-video"
              src={src}
              onTimeUpdate={onTimeUpdate}
              onEnded={() => setPlaying(false)}
              preload="auto"
              style={{ display: showVideo ? "block" : "none" }}
            />
            {/* O canvas: composição (parado) ou quadro exato. Fica por cima do
                <video> pra a troca parar↔tocar não piscar preto. */}
            <canvas
              ref={canvasRef}
              className="stage-canvas"
              style={{ display: painted && !playing ? "block" : "none" }}
            />
          </>
        ) : (
          <div className="stage-empty muted">{gone ? t("preview.gone") : t("preview.empty")}</div>
        )}
      </div>

      <div className="preview-bar">
        <button
          onClick={() => useEditor.getState().nudgeRate(-1)}
          disabled={!baseHit || gone}
          title={t("sc.jkl")}
        >
          ◀◀ J
        </button>
        <button
          className="primary"
          onClick={() => setPlaying(!playing)}
          disabled={!baseHit || gone}
          title={playing ? t("preview.pause") : t("preview.play")}
        >
          {playing ? "❚❚" : "▶"} {playing ? t("preview.pause") : t("preview.play")}
        </button>
        <button
          onClick={() => useEditor.getState().nudgeRate(1)}
          disabled={!baseHit || gone}
          title={t("sc.jkl")}
        >
          L ▶▶
        </button>
        <span className="muted small">{quality}</span>
      </div>
    </div>
  );
}

/** Resolução de saída da composição (a do 1º clipe de mídia de vídeo). */
function targetDims(
  tl: ReturnType<typeof useEditor.getState>["history"]["present"],
  media: Record<string, { width: number; height: number }>,
): { w: number; h: number } {
  for (const tk of tl.tracks) {
    if (tk.kind !== "video") continue;
    for (const c of tk.clips) {
      if (c.path && media[c.path]) return { w: media[c.path].width, h: media[c.path].height };
    }
  }
  return { w: 1920, h: 1080 };
}

/**
 * Desenha um clipe de mídia no canvas: recorte (crop) na fonte, PiP (posição +
 * tamanho) OU encaixe no quadro com barra, opacidade e cor (aproximada). É o
 * espelho do que o compilador faz no export.
 */
function drawMedia(
  ctx: CanvasRenderingContext2D,
  frame: VideoFrame,
  clip: Clip,
  W: number,
  H: number,
  alpha: number,
): void {
  const fw = frame.displayWidth;
  const fh = frame.displayHeight;
  // Recorte na fonte.
  let sx = 0;
  let sy = 0;
  let sw = fw;
  let sh = fh;
  if (clip.crop) {
    sx = clip.crop.x * fw;
    sy = clip.crop.y * fh;
    sw = Math.max(1, clip.crop.w * fw);
    sh = Math.max(1, clip.crop.h * fh);
  }
  const aspect = sw / sh;

  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.filter = clip.color ? colorToCanvasFilter(clip.color) : "none";

  if (clip.transform) {
    // PiP: largura = fração da saída; altura mantém o aspecto (como o scale=pw:-2).
    const dw = clip.transform.scale * W;
    const dh = dw / aspect;
    const dx = clip.transform.x * W;
    const dy = clip.transform.y * H;
    ctx.drawImage(frame, sx, sy, sw, sh, dx, dy, dw, dh);
  } else {
    // Quadro cheio, com barra (nunca esticado) — igual ao scale+pad do export.
    const scale = Math.min(W / sw, H / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(frame, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  ctx.globalAlpha = 1;
  ctx.filter = "none";
}

/** Desenha um título como TEXTO no canvas (não chama ffmpeg na prévia). Espelha
 *  o `drawtext`: centralizado em x, âncora em cima/meio/embaixo, borda preta. */
function drawTitle(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  W: number,
  H: number,
  alpha: number,
): void {
  const tp = clip.title!;
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.filter = "none";
  ctx.font = `${tp.fontSizePx}px sans-serif`;
  ctx.textAlign = "center";
  const x = W / 2;
  let y: number;
  if (tp.anchor === "top") {
    ctx.textBaseline = "top";
    y = H * 0.08;
  } else if (tp.anchor === "center") {
    ctx.textBaseline = "middle";
    y = H / 2;
  } else {
    ctx.textBaseline = "alphabetic";
    y = H - H * 0.08;
  }
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.strokeText(tp.text, x, y);
  ctx.fillStyle = tp.color;
  ctx.fillText(tp.text, x, y);
  ctx.globalAlpha = 1;
}
