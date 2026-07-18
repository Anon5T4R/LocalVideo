import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { audioLayersAt, hasMixAudio } from "../lib/audiomix";
import { colorToCanvasFilter, layersAt, needsComposite, type MediaLayer } from "../lib/compose";
import { canDecodeExactly, FrameSource, hasWebCodecs } from "../lib/decoder";
import { t } from "../lib/i18n";
import { containRect, movePip, pipBox, resizePip, type Corner } from "../lib/pip";
import { formatDuration, formatTimecode, gapAdvance } from "../lib/probe";
import {
  baseVideoTrack,
  clipEnd,
  endHit,
  isMedia,
  locate,
  srcOut,
  timelineDuration,
  timeToClip,
  type Clip,
  type Transform,
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
  const selectedId = useEditor((s) => s.selectedId);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
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

  // O PRÓXIMO clipe de mídia da base à frente do playhead — só interessa quando
  // se está num BURACO. Serve pra PRÉ-CARREGAR: apontamos o `<video>` (escondido)
  // pra ele durante o vazio, com `preload="auto"`, pra quando o ticker chegar no
  // clipe o play ser instantâneo. Sem isto, o `<video>` só ganhava `src` no
  // limite do buraco e travava carregando do zero no meio da reprodução (o
  // elemento fica em readyState 0 e o play não engata).
  const nextBaseClip = useMemo(() => {
    if (baseHit) return null;
    let best: Clip | null = null;
    for (const c of track?.clips ?? []) {
      if (isMedia(c) && c.startMs >= playhead && (!best || c.startMs < best.startMs)) best = c;
    }
    return best;
  }, [track, baseHit, playhead]);

  // O src do `<video>`: o clipe atual quando há um; senão o próximo (aquecendo no
  // buraco). String vazia só quando não há nem um nem outro (fim do filme).
  const warmPath = nextBaseClip && !missing.includes(nextBaseClip.path!) ? nextBaseClip.path! : "";
  const src = baseHit && !gone ? convertFileSrc(hitPath) : warmPath ? convertFileSrc(warmPath) : "";

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
    // `baseHit` é obrigatório aqui: no BURACO o `<video>` fica montado mas SEM
    // src (ver o render). Chamar `play()` num elemento sem fonte REJEITA, e o
    // `.catch` abaixo pausaria o filme no meio do vazio — quem toca o buraco é o
    // ticker de wall-clock, não o `<video>`. Sem clipe embaixo: só pausa o vídeo.
    if (playing && !gone && rate > 0 && baseHit) {
      // Ao ASSUMIR um clipe já tocando (o caso do buraco: o `<video>` ganha src
      // só agora, zerado), crava o tempo-fonte ANTES de tocar. Sem isto, um clipe
      // aparado (srcIn > 0) tocaria do 0 e o `onTimeUpdate` puxaria o playhead
      // pra trás. Só aqui (roda na TROCA de clipe, não a cada quadro), com folga
      // pra não brigar com o play.
      const want = baseHit.srcTime / 1000;
      if (Math.abs(v.currentTime - want) > 0.15) v.currentTime = want;
      v.playbackRate = rate;
      void v.play().catch(() => setPlaying(false));
    } else {
      v.pause();
    }
  }, [playing, gone, rate, baseHit?.clip.id, setPlaying]);

  // Correr PELO VAZIO (pra frente): quando o playhead está num buraco não há
  // `<video>` pra tocar, então nada movia o tempo e o Espaço parecia morto. Um
  // NLE de verdade não pula nem trava o buraco — deixa o tempo andar (tela
  // preta) até cair no próximo clipe ou no fim. O relógio de parede é o motor.
  //
  // Só liga sem `baseHit` (o buraco) e com `rate > 0` (a ré tem o ticker acima);
  // assim que o tempo cruza pra dentro de um clipe, `baseHit` deixa de ser nulo,
  // este efeito se desmonta e o `<video>` assume — sem pulo nem piscada. O
  // `playhead` NÃO entra nas deps de propósito: ele é lido do `getState()` a
  // cada quadro, senão o efeito remontaria a cada tick e zeraria o `dt`.
  useEffect(() => {
    if (!playing || rate <= 0 || baseHit) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const s = useEditor.getState();
      const dur = timelineDuration(s.history.present);
      const stepd = gapAdvance(s.playhead, dt, s.rate, dur);
      s.seek(stepd.playhead);
      if (stepd.ended) {
        s.setPlaying(false);
        return; // chegou ao fim do filme: para (não reagenda)
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, baseHit]);

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

  // Há trilha de fundo pra mixar? Aviso honesto: a prévia AGORA toca a 2ª trilha
  // (o buraco que a v0.3 fechou), mas amplificar acima de 100% só sai no export.
  const mixNote = hasMixAudio(timeline, track?.id ?? null);

  const showVideo = baseHit && !gone && !doComposite;

  // A alça de PiP DIRETA na prévia: aparece quando o clipe selecionado é mídia
  // COM transform e está ativo no instante atual (senão a caixa não teria frame
  // embaixo). Some no play — arrastar contra o ticker seria briga de relógio.
  const pipClip = (() => {
    if (playing || !selectedId) return null;
    const loc = locate(timeline, selectedId);
    const c = loc?.clip;
    if (!c || !isMedia(c) || !c.transform) return null;
    if (playhead < c.startMs || playhead >= clipEnd(c)) return null;
    return c;
  })();

  // Buraco num filme que EXISTE: nem clipe embaixo, nem mídia sumida. A tela
  // fica preta (o fundo do `.stage` já é #000) e o tempo corre por cima — não é
  // "importe um vídeo" (isso é `total === 0`), é o vazio entre cortes.
  const inGap = !baseHit && !gone && total > 0;
  // Dá pra tocar? Filme não-vazio e não parado num arquivo sumido. Vale pro
  // buraco também (corre pelo vazio) — por isso não exige `baseHit`.
  const canPlay = total > 0 && !gone;

  return (
    <div className="card preview-card">
      {/* O motor de áudio das trilhas de fundo — não desenha nada, só toca. */}
      <PreviewAudioMixer />
      <div className="card-head">
        <strong>{t("preview.title")}</strong>
        <span className="muted small tabnum">
          {formatTimecode(playhead, fps)} / {formatDuration(total)}
          {playing && rate !== 1 ? ` · ${rate > 0 ? "" : "◀ "}${Math.abs(rate)}×` : ""}
        </span>
      </div>

      <div className="stage" ref={stageRef}>
        {gone ? (
          <div className="stage-empty muted">{t("preview.gone")}</div>
        ) : total > 0 ? (
          <>
            {/* O `<video>` fica SEMPRE montado enquanto há filme — inclusive no
                buraco (só escondido). Se ele desmontasse no vazio e remontasse ao
                cavar no clipe, o elemento novo teria que carregar do zero e o play
                travava no limite do buraco (readyState 0). Mantendo o MESMO
                elemento, cair do vazio pro clipe é só uma troca de `src` — o
                caminho de play que já funciona. `src=undefined` no buraco pra o
                navegador não tentar carregar a própria página como mídia. */}
            <video
              ref={videoRef}
              className="stage-video"
              src={src || undefined}
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
            {/* Buraco: um preto por cima do <video> escondido. Sem texto — o tempo
                correndo no cabeçalho já diz que está tocando pelo vazio. */}
            {inGap ? <div className="stage-empty" aria-label={t("preview.gap")} /> : null}
            {/* Alças de PiP: arrastar/redimensionar a caixa direto na prévia. */}
            {pipClip ? (
              <PipHandles clip={pipClip} dims={dims} media={media} stageRef={stageRef} />
            ) : null}
          </>
        ) : (
          <div className="stage-empty muted">{t("preview.empty")}</div>
        )}
      </div>

      <div className="preview-bar">
        <button
          onClick={() => useEditor.getState().nudgeRate(-1)}
          disabled={!canPlay}
          title={t("sc.jkl")}
        >
          ◀◀ J
        </button>
        <button
          className="primary"
          onClick={() => setPlaying(!playing)}
          disabled={!canPlay}
          title={playing ? t("preview.pause") : t("preview.play")}
        >
          {playing ? "❚❚" : "▶"} {playing ? t("preview.pause") : t("preview.play")}
        </button>
        <button
          onClick={() => useEditor.getState().nudgeRate(1)}
          disabled={!canPlay}
          title={t("sc.jkl")}
        >
          L ▶▶
        </button>
        <span className="muted small">{quality}</span>
        {mixNote ? (
          <span className="muted small" title={t("preview.mixHint")}>
            {t("preview.mix")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Estado de um arrasto de PiP em curso (guarda o que não pode mudar no meio). */
type PipDrag =
  | { kind: "move"; x0: number; y0: number; base: Transform; cw: number; ch: number }
  | {
      kind: "resize";
      corner: Corner;
      base: Transform;
      rectLeft: number;
      rectTop: number;
      cw: number;
      ch: number;
    };

/** Tolerância do snap do PiP, em fração do quadro — o mesmo "quase encostou,
 *  então encostou" da régua, só que aqui contra as bordas e o centro da tela. */
const PIP_SNAP = 0.02;

/**
 * As ALÇAS do PiP direto na prévia (o item de maior valor da rodada de
 * excelência): a caixa do overlay vira arrastável e redimensionável POR CIMA do
 * WYSIWYG, e o resultado atualiza ao vivo (é o mesmo `transform` que o inspetor
 * e o compilador leem — arrastar aqui é escrever o param que o export usa).
 *
 * A matemática (mover, redimensionar por canto com aspecto travado, snap, o
 * retângulo do conteúdo no letterbox) mora em `lib/pip.ts`, pura e testada.
 * Aqui só se converte pixel↔fração e se escuta o ponteiro — e, crucial, o
 * arrasto inteiro é UM passo de undo (`beginEdit`/`endEdit` + o `doUpdateClip`
 * que coalesce dentro da sessão).
 */
function PipHandles({
  clip,
  dims,
  media,
  stageRef,
}: {
  clip: Clip;
  dims: { w: number; h: number };
  media: Record<string, { width: number; height: number }>;
  stageRef: React.RefObject<HTMLDivElement | null>;
}) {
  const doUpdateClip = useEditor((s) => s.doUpdateClip);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<PipDrag | null>(null);

  // Mede o palco e segue o resize da janela — as alças têm que colar no
  // retângulo do conteúdo, não numa medida velha de outro tamanho de janela.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageRef]);

  const outAspect = dims.w / dims.h;
  // Aspecto do frame JÁ recortado (o mesmo do `drawMedia`). Sem info da mídia,
  // cai no aspecto de saída — a caixa não distorce, só pode não bater o recorte.
  const info = clip.path ? media[clip.path] : undefined;
  const clipAspect = (() => {
    if (!info) return outAspect;
    const cw = clip.crop ? clip.crop.w * info.width : info.width;
    const ch = clip.crop ? clip.crop.h * info.height : info.height;
    return ch > 0 && cw > 0 ? cw / ch : outAspect;
  })();

  const content = containRect(stageSize.w, stageSize.h, dims.w, dims.h);
  const tr = clip.transform!;
  const box = pipBox(tr, clipAspect, outAspect);

  // O arrasto: um par estável de listeners por sessão (padrão da régua). O
  // `dragRef` sobrevive ao re-render; o efeito só liga/desliga os ouvintes.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "move") {
        const dx = (e.clientX - d.x0) / d.cw;
        const dy = (e.clientY - d.y0) / d.ch;
        const r = movePip(d.base, clipAspect, outAspect, dx, dy, PIP_SNAP);
        doUpdateClip(clip.id, { transform: r.transform });
      } else {
        const px = clamp01((e.clientX - d.rectLeft) / d.cw);
        const py = clamp01((e.clientY - d.rectTop) / d.ch);
        doUpdateClip(clip.id, {
          transform: resizePip(d.base, clipAspect, outAspect, d.corner, px, py),
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      useEditor.getState().endEdit();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const startMove = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useEditor.getState().beginEdit();
    dragRef.current = {
      kind: "move",
      x0: e.clientX,
      y0: e.clientY,
      base: tr,
      cw: content.width,
      ch: content.height,
    };
    setDragging(true);
  };
  const startResize = (corner: Corner) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = stageRef.current?.getBoundingClientRect();
    useEditor.getState().beginEdit();
    dragRef.current = {
      kind: "resize",
      corner,
      base: tr,
      rectLeft: (rect?.left ?? 0) + content.left,
      rectTop: (rect?.top ?? 0) + content.top,
      cw: content.width,
      ch: content.height,
    };
    setDragging(true);
  };

  if (content.width <= 0) return null;
  const corners: Corner[] = ["nw", "ne", "sw", "se"];
  // Guia de centro: aparece durante o arrasto quando a caixa está centrada — o
  // sinal visual de que o snap agarrou o meio da tela.
  const centeredX = Math.abs(box.x + box.w / 2 - 0.5) < 0.003;
  const centeredY = Math.abs(box.y + box.h / 2 - 0.5) < 0.003;

  return (
    <div className={`pip-overlay ${dragging ? "dragging" : ""}`}>
      <div
        className="pip-box"
        style={{
          left: content.left + box.x * content.width,
          top: content.top + box.y * content.height,
          width: box.w * content.width,
          height: box.h * content.height,
        }}
        onPointerDown={startMove}
        title={t("pip.dragHint")}
      >
        {corners.map((c) => (
          <span key={c} className={`pip-h ${c}`} onPointerDown={startResize(c)} />
        ))}
      </div>
      {dragging && centeredX ? (
        <div className="pip-guide v" style={{ left: content.left + content.width / 2 }} />
      ) : null}
      {dragging && centeredY ? (
        <div className="pip-guide h" style={{ top: content.top + content.height / 2 }} />
      ) : null}
    </div>
  );
}

/** Grampeia em 0..1 (guarda de NaN). */
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/**
 * O motor de áudio da 2ª trilha (música de fundo, narração) na PRÉVIA.
 *
 * Não renderiza nada: conduz um `<audio>` por clipe de áudio de mix — todas as
 * trilhas menos a base, cujo som já sai pelo `<video>` — em sincronia com o
 * playhead, pra a mixagem se OUVIR antes do export. A parte pura (quais tocam,
 * com que ganho) mora em `lib/audiomix.ts`, com as ressalvas de honestidade.
 *
 * Os `<audio>` são objetos imperativos (`new Audio()`), não JSX: som se comanda,
 * não se declara, e um por CLIPE (chaveado pelo id) sobrevive à troca de clipe
 * ativo sem recarregar o arquivo a cada quadro.
 */
function PreviewAudioMixer() {
  const timeline = useEditor((s) => s.history.present);
  const playing = useEditor((s) => s.playing);
  const rate = useEditor((s) => s.rate);
  const missing = useEditor((s) => s.missing);

  const baseId = useMemo(() => baseVideoTrack(timeline)?.id ?? null, [timeline]);
  const els = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Fecha os <audio> de clipes que saíram da timeline (ou viraram a base).
  useEffect(() => {
    const alive = new Set<string>();
    for (const tk of timeline.tracks) {
      if (tk.id === baseId) continue;
      for (const c of tk.clips) if (isMedia(c)) alive.add(c.id);
    }
    for (const [id, el] of els.current) {
      if (!alive.has(id)) {
        el.pause();
        el.src = "";
        els.current.delete(id);
      }
    }
  }, [timeline, baseId]);

  // Descarrega tudo ao desmontar (memória de áudio fora do alcance do GC).
  useEffect(() => {
    const map = els.current;
    return () => {
      for (const el of map.values()) {
        el.pause();
        el.src = "";
      }
      map.clear();
    };
  }, []);

  // O laço que casa som e playhead. Só toca no play PRA FRENTE: a ré e o scrub
  // em 2× seriam pitch picado sem valor (a base também não os mixa). Lê o estado
  // por `getState()` a cada quadro pra não remontar o efeito a cada tick — e o
  // `playhead` fica FORA das deps de propósito (senão remontaria 60×/s).
  useEffect(() => {
    if (!playing || rate <= 0) {
      for (const el of els.current.values()) el.pause();
      return;
    }
    let raf = 0;
    const tick = () => {
      const s = useEditor.getState();
      const layers = audioLayersAt(s.history.present, s.playhead, baseId).filter(
        (l) => !missing.includes(l.path),
      );
      const wanted = new Set(layers.map((l) => l.clipId));
      for (const [id, el] of els.current) if (!wanted.has(id)) el.pause();
      for (const l of layers) {
        let el = els.current.get(l.clipId);
        if (!el) {
          el = new Audio(convertFileSrc(l.path));
          el.preload = "auto";
          els.current.set(l.clipId, el);
        }
        el.volume = l.gain;
        el.playbackRate = s.rate;
        // Ressincroniza só quando DERIVA de verdade: o <audio> tem relógio
        // próprio e cravar o tempo todo quadro cortaria o som. 0,25 s de folga.
        const want = l.srcTimeMs / 1000;
        if (Number.isFinite(want) && Math.abs(el.currentTime - want) > 0.25) {
          try {
            el.currentTime = want;
          } catch {
            /* fonte ainda carregando: o próximo quadro corrige */
          }
        }
        if (el.paused) void el.play().catch(() => {});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const el of els.current.values()) el.pause();
    };
  }, [playing, rate, baseId, missing]);

  return null;
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
