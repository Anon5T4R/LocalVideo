import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { canDecodeExactly, FrameSource, hasWebCodecs } from "../lib/decoder";
import { t } from "../lib/i18n";
import { formatDuration, formatTimecode } from "../lib/probe";
import { timeToClip, totalDuration } from "../lib/timeline";
import { useEditor } from "../state/editor";

/**
 * Prévia da timeline montada.
 *
 * **Dois motores, cada um no que sabe fazer:**
 *
 * - O `<video>` é dono do PLAY: ele traz áudio e ritmo de graça, e ninguém
 *   reescreve um sincronizador de A/V por diversão.
 * - O `VideoDecoder` (canvas por cima) é dono do PARADO: quando o playhead para,
 *   o quadro exato é decodificado na mão e pintado. É o que faz a seta andar UM
 *   quadro — o `<video>` mostra "por perto", e "por perto" num editor é o que
 *   faz o usuário desconfiar do corte que acabou de fazer.
 *
 * **Degradar dizendo a verdade** (`preview.rough*`): sem `VideoDecoder`, ou num
 * container que o demuxer não abre (mkv/webm/avi — ver `lib/decoder.ts`), fica
 * só o `<video>` e a UI **avisa que a prévia é aproximada**. Prometer precisão
 * que não se tem é pior do que não ter.
 */
export default function Preview() {
  const track = useEditor((s) => s.history.present);
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

  const hit = useMemo(() => timeToClip(track, playhead), [track, playhead]);
  const total = useMemo(() => totalDuration(track), [track]);
  const gone = hit ? missing.includes(hit.clip.path) : false;
  const fps = hit ? (media[hit.clip.path]?.fps ?? 30) : 30;
  const exact = hit && !gone ? canDecodeExactly(hit.clip.path) : false;

  const src = hit && !gone ? convertFileSrc(hit.clip.path) : "";

  // Fecha os decodificadores dos arquivos que saíram da timeline. `VideoFrame` e
  // `VideoDecoder` seguram memória de VÍDEO, fora do alcance do coletor de lixo.
  useEffect(() => {
    const alive = new Set(track.clips.map((c) => c.path));
    for (const [path, fs] of sources.current) {
      if (!alive.has(path)) {
        fs.dispose();
        sources.current.delete(path);
      }
    }
  }, [track]);

  useEffect(() => {
    const map = sources.current;
    return () => {
      for (const fs of map.values()) fs.dispose();
      map.clear();
    };
  }, []);

  /* ---------- o quadro exato (parado) ---------- */

  useEffect(() => {
    // Durante o play quem manda é o `<video>`: decodificar por fora seria
    // desenhar um segundo filme, meio quadro atrás do primeiro.
    if (!hit || gone || playing || !exact) {
      setPainted(false);
      return;
    }

    let dead = false;
    const path = hit.clip.path;
    const targetUs = Math.round(hit.srcTime * 1000);

    void (async () => {
      let fs = sources.current.get(path);
      if (!fs) {
        fs = new FrameSource(convertFileSrc(path));
        sources.current.set(path, fs);
      }
      let frame: VideoFrame | null = null;
      try {
        frame = await fs.frameAt(targetUs);
      } catch {
        // Arquivo que o demuxer não engoliu: o `<video>` continua ali embaixo e
        // a UI já diz que a prévia é aproximada. Nada de erro na cara.
        frame = null;
      }
      // O playhead andou enquanto isto decodificava: este quadro é passado.
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
      ctx.drawImage(frame, 0, 0);
      // Fechar SEMPRE, e logo depois de pintar: o pixel já está no canvas.
      frame.close();
      setPainted(true);
    })();

    return () => {
      dead = true;
    };
  }, [hit, gone, playing, exact]);

  /* ---------- o play (o <video> manda) ---------- */

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !hit || playing) return;
    const want = hit.srcTime / 1000;
    if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want;
  }, [hit, playing]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // Ré (J) não é play: o `<video>` não toca pra trás. Quem anda é o playhead,
    // no laço de rAF abaixo — e o vídeo fica parado, servindo de quadro.
    if (playing && !gone && rate > 0) {
      v.playbackRate = rate;
      void v.play().catch(() => setPlaying(false));
    } else {
      v.pause();
    }
  }, [playing, gone, rate, hit?.clip.id, setPlaying]);

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

  // Durante o play, quem manda no playhead é o vídeo (o relógio real).
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || !hit || !playing || rate < 0) return;
    const srcMs = v.currentTime * 1000;
    // Passou do fim APARADO do clipe? Pula pra emenda seguinte — é o corte
    // acontecendo na prévia, sem tocar em byte nenhum do arquivo.
    if (srcMs >= hit.clip.srcOut - 1) {
      const next = hit.clipStart + (hit.clip.srcOut - hit.clip.srcIn);
      if (next >= total) {
        setPlaying(false);
        seek(total);
      } else {
        seek(next);
      }
      return;
    }
    seek(hit.clipStart + (srcMs - hit.clip.srcIn));
  };

  /** O rodapé conta o que a prévia É — e por que, quando é aproximada. */
  const quality = !hit
    ? ""
    : exact
      ? t("preview.exact")
      : !hasWebCodecs()
        ? t("preview.roughNoCodecs")
        : t("preview.roughContainer");

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
        {hit && !gone ? (
          <>
            <video
              ref={videoRef}
              className="stage-video"
              src={src}
              onTimeUpdate={onTimeUpdate}
              onEnded={() => setPlaying(false)}
              preload="auto"
            />
            {/* Por cima do <video>, e só quando há quadro exato pintado: assim a
                troca entre parar e tocar não pisca preto. */}
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
          disabled={!hit || gone}
          title={t("sc.jkl")}
        >
          ◀◀ J
        </button>
        <button
          className="primary"
          onClick={() => setPlaying(!playing)}
          disabled={!hit || gone}
          title={playing ? t("preview.pause") : t("preview.play")}
        >
          {playing ? "❚❚" : "▶"} {playing ? t("preview.pause") : t("preview.play")}
        </button>
        <button
          onClick={() => useEditor.getState().nudgeRate(1)}
          disabled={!hit || gone}
          title={t("sc.jkl")}
        >
          L ▶▶
        </button>
        <span className="muted small">{quality}</span>
      </div>
    </div>
  );
}
