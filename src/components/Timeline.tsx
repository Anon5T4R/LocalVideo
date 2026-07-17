import { useEffect, useMemo, useRef, useState } from "react";

import { t } from "../lib/i18n";
import { formatDuration, nearestThumb } from "../lib/probe";
import { clipDuration, clipStarts, totalDuration, type Clip } from "../lib/timeline";
import { baseName, useEditor } from "../state/editor";

/** Passos de régua "redondos" (ms). Um tick a cada 3 segundos e meio não
 *  ajuda ninguém a se localizar — a escala tem que ser de relógio. */
const TICK_STEPS = [200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 300_000, 600_000];
const MIN_TICK_PX = 64;
const THUMB_W = 90;

/**
 * A timeline: régua com zoom, clipes com miniaturas, playhead, seleção,
 * arrastar pra reordenar e alças pra aparar.
 *
 * Toda a matemática de EDIÇÃO mora em `lib/timeline.ts` (puro e testado); aqui
 * só se converte pixel↔milissegundo e se escuta o mouse.
 */
export default function Timeline() {
  const track = useEditor((s) => s.history.present);
  const thumbs = useEditor((s) => s.thumbs);
  const missing = useEditor((s) => s.missing);
  const media = useEditor((s) => s.media);
  const playhead = useEditor((s) => s.playhead);
  const selectedId = useEditor((s) => s.selectedId);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const seek = useEditor((s) => s.seek);
  const select = useEditor((s) => s.select);
  const setZoom = useEditor((s) => s.setZoom);
  const doMove = useEditor((s) => s.doMove);
  const doTrim = useEditor((s) => s.doTrim);
  const doSplit = useEditor((s) => s.doSplit);
  const doRemove = useEditor((s) => s.doRemove);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const total = useMemo(() => totalDuration(track), [track]);
  const starts = useMemo(() => clipStarts(track), [track]);
  const msToPx = (ms: number) => (ms / 1000) * pxPerSec;
  const pxToMs = (px: number) => (px / pxPerSec) * 1000;
  const width = Math.max(msToPx(total), 1);

  /* ---- aparar arrastando a alça (pointer, não HTML5 DnD: precisa de ms
     contínuo, e o DnD nativo só avisa em passos grosseiros) ---- */
  const trimRef = useRef<{ id: string; edge: "in" | "out"; x0: number; in0: number; out0: number } | null>(
    null,
  );
  const [trimming, setTrimming] = useState(false);

  useEffect(() => {
    if (!trimming) return;
    const onMove = (e: PointerEvent) => {
      const st = trimRef.current;
      if (!st) return;
      const delta = pxToMs(e.clientX - st.x0);
      if (st.edge === "in") doTrim(st.id, st.in0 + delta, st.out0);
      else doTrim(st.id, st.in0, st.out0 + delta);
    };
    const onUp = () => {
      trimRef.current = null;
      setTrimming(false);
      // Fecha a sessão: o próximo aparo empilha de novo. Sem isto, dois arrastos
      // seguidos virariam UM passo de undo só — o erro oposto, e igualmente ruim.
      useEditor.getState().endTrim();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimming, pxPerSec]);

  const startTrim = (e: React.PointerEvent, c: Clip, edge: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    select(c.id);
    trimRef.current = { id: c.id, edge, x0: e.clientX, in0: c.srcIn, out0: c.srcOut };
    setTrimming(true);
    // O arrasto inteiro é UM passo de undo (ver `replacePresent` em lib/timeline).
    useEditor.getState().beginTrim();
  };

  const seekFromEvent = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    const x = e.clientX - el.getBoundingClientRect().left + el.scrollLeft;
    seek(pxToMs(x));
  };

  /** Ticks visíveis: o primeiro passo redondo que não amontoa os rótulos. */
  const step = TICK_STEPS.find((s) => msToPx(s) >= MIN_TICK_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let ms = 0; ms <= total; ms += step) ticks.push(ms);

  const fit = () => {
    const el = scrollRef.current;
    if (!el || total <= 0) return;
    setZoom(((el.clientWidth - 24) / total) * 1000);
  };

  return (
    <div className="tl">
      <div className="tl-head">
        <strong>{t("tl.title")}</strong>
        <span className="muted small">
          {t("tl.stats", { n: track.clips.length, dur: formatDuration(total) })}
        </span>
        <span className="toolbar-fill" />
        <button onClick={doSplit} title={t("tl.split")} disabled={track.clips.length === 0}>
          ✂ {t("tl.split")}
        </button>
        <button onClick={() => doRemove()} title={t("tl.remove")} disabled={!selectedId}>
          🗑 {t("tl.remove")}
        </button>
        <span className="tl-zoom">
          <button onClick={() => setZoom(pxPerSec / 1.5)} title={t("tl.zoomOut")}>
            −
          </button>
          <button onClick={fit} title={t("tl.zoomFit")} disabled={total <= 0}>
            ⤢
          </button>
          <button onClick={() => setZoom(pxPerSec * 1.5)} title={t("tl.zoomIn")}>
            +
          </button>
        </span>
      </div>

      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-inner" style={{ width }}>
          {/* régua */}
          <div className="tl-ruler" onClick={seekFromEvent}>
            {ticks.map((ms) => (
              <span key={ms} className="tl-tick" style={{ left: msToPx(ms) }}>
                <i />
                <em>{formatDuration(ms)}</em>
              </span>
            ))}
          </div>

          {/* clipes */}
          <div
            className="tl-track"
            onClick={(e) => {
              // Clicar no vazio da trilha: só move o playhead, não desmarca —
              // desmarcar por engano no meio de um trim seria hostil.
              if (e.target === e.currentTarget) seekFromEvent(e);
            }}
            onDragOver={(e) => {
              if (dragId) e.preventDefault();
            }}
            onDrop={() => {
              if (dragId && dropIndex !== null) doMove(dragId, dropIndex);
              setDragId(null);
              setDropIndex(null);
            }}
          >
            {track.clips.map((c, i) => {
              const w = msToPx(clipDuration(c));
              const strip = thumbs[c.path];
              const isGone = missing.includes(c.path);
              const info = media[c.path];
              // `round`, não `floor`: as fatias dividem a largura do clipe entre
              // si (ver `.tl-thumbs img` no CSS), então o que importa é o número
              // que deixa cada uma MAIS PERTO de `THUMB_W` — arredondar pra
              // baixo só esticava demais a última.
              const slots = Math.max(1, Math.round(w / THUMB_W));
              return (
                <div
                  key={c.id}
                  className={[
                    "tl-clip",
                    selectedId === c.id ? "sel" : "",
                    dragId === c.id ? "dragging" : "",
                    isGone ? "gone" : "",
                    dropIndex === i && dragId && dragId !== c.id ? "drop-before" : "",
                  ]
                    .join(" ")
                    .trim()}
                  style={{ width: w }}
                  onClick={(e) => {
                    select(c.id);
                    seekFromEvent(e);
                  }}
                  draggable={!trimming}
                  onDragStart={() => setDragId(c.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropIndex(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    // Metade esquerda ⇒ cai antes deste; metade direita ⇒ depois.
                    const r = e.currentTarget.getBoundingClientRect();
                    setDropIndex(e.clientX < r.left + r.width / 2 ? i : i + 1);
                  }}
                  title={baseName(c.path)}
                >
                  <div className="tl-thumbs" aria-hidden>
                    {strip && strip.urls.length > 0
                      ? Array.from({ length: slots }, (_, k) => {
                          // Instante-fonte do meio desta fatia do clipe.
                          const at = c.srcIn + ((clipDuration(c) * (2 * k + 1)) / (2 * slots));
                          const idx = nearestThumb(strip.timesMs, at);
                          return <img key={k} src={strip.urls[idx]} alt="" draggable={false} />;
                        })
                      : null}
                  </div>
                  <div className="tl-clip-label">
                    <span>{baseName(c.path)}</span>
                    <span className="muted">{formatDuration(clipDuration(c))}</span>
                    {info && !strip ? <span className="muted">· {t("tl.noThumbs")}</span> : null}
                  </div>
                  <span
                    className="tl-handle in"
                    onPointerDown={(e) => startTrim(e, c, "in")}
                    onClick={(e) => e.stopPropagation()}
                    title={t("clip.trimIn")}
                  />
                  <span
                    className="tl-handle out"
                    onPointerDown={(e) => startTrim(e, c, "out")}
                    onClick={(e) => e.stopPropagation()}
                    title={t("clip.trimOut")}
                  />
                </div>
              );
            })}
            {dragId && dropIndex === track.clips.length ? <div className="tl-drop-end" /> : null}
          </div>

          {/* playhead por cima de tudo */}
          <div className="tl-playhead" style={{ left: msToPx(playhead) }}>
            <i />
          </div>
        </div>
      </div>

      <div className="tl-foot muted small">
        {starts.length > 0 ? t("tl.dragHint") : t("empty.tip")}
      </div>
    </div>
  );
}
