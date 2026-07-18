import { useEffect, useMemo, useRef, useState } from "react";

import { t } from "../lib/i18n";
import Icon from "./Icon";
import { formatDuration, nearestThumb } from "../lib/probe";
import { snapMove, snapValue } from "../lib/snap";
import {
  clipDuration,
  clipEnd,
  isMedia,
  isTitle,
  locate,
  overlapWithNext,
  timelineDuration,
  type Clip,
  type Timeline,
  type Track,
} from "../lib/timeline";
import { baseName, useEditor } from "../state/editor";

/** Passos de régua "redondos" (ms) — a escala tem que ser de relógio. */
const TICK_STEPS = [200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 300_000, 600_000];
const MIN_TICK_PX = 64;
const THUMB_W = 90;
const LANE_H = 60;

/** O que está sendo arrastado agora. */
type Drag =
  | { kind: "move"; id: string; x0: number; start0: number; dur0: number; trackId: string }
  | { kind: "in" | "out"; id: string; x0: number; start0: number; end0: number }
  | { kind: "trans"; id: string; x0: number; trans0: number };

/** Distância (px) em que uma borda "quase encostou" já encaixa numa marca. */
const SNAP_PX = 8;

/**
 * As marcas de encaixe: as bordas de todos os OUTROS clipes (começo e fim, em
 * todas as trilhas), o playhead e o zero. Pura pra a régua não precisar recalcular
 * na mão a cada quadro do arrasto.
 */
function snapTargets(tl: Timeline, exceptId: string, playhead: number): number[] {
  const out: number[] = [0, playhead];
  for (const tk of tl.tracks) {
    for (const c of tk.clips) {
      if (c.id === exceptId) continue;
      out.push(c.startMs, clipEnd(c));
    }
  }
  return out;
}

/**
 * A timeline multitrilha da v0.2: trilhas empilhadas, clipes posicionados no
 * tempo (`startMs`), arrastar pra mover no tempo E entre trilhas, alças pra
 * aparar, e a alça de transição (crossfade) na emenda.
 *
 * Toda a matemática de EDIÇÃO mora em `lib/timeline.ts` (puro e testado); aqui
 * só se converte pixel↔ms e se escuta o ponteiro. O arrasto usa `pointer` (não
 * o DnD nativo) porque precisa de ms contínuo — o DnD só avisa em passos
 * grosseiros e não sabe dizer em qual trilha o dedo está.
 */
export default function Timeline() {
  const timeline = useEditor((s) => s.history.present);
  const thumbs = useEditor((s) => s.thumbs);
  const missing = useEditor((s) => s.missing);
  const media = useEditor((s) => s.media);
  const playhead = useEditor((s) => s.playhead);
  const selectedId = useEditor((s) => s.selectedId);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const seek = useEditor((s) => s.seek);
  const select = useEditor((s) => s.select);
  const setZoom = useEditor((s) => s.setZoom);
  const doTrimEdge = useEditor((s) => s.doTrimEdge);
  const doMoveClip = useEditor((s) => s.doMoveClip);
  const doSetTransition = useEditor((s) => s.doSetTransition);
  const doSplit = useEditor((s) => s.doSplit);
  const doRemove = useEditor((s) => s.doRemove);
  const doAddTrack = useEditor((s) => s.doAddTrack);
  const rippleMode = useEditor((s) => s.rippleMode);
  const setRippleMode = useEditor((s) => s.setRippleMode);

  const scrollRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  /** A marca (ms) onde o arrasto encaixou agora — pra desenhar a guia. `null` =
   *  não encaixou (ou não há arrasto). */
  const [snapLine, setSnapLine] = useState<number | null>(null);

  const total = useMemo(() => timelineDuration(timeline), [timeline]);
  const msToPx = (ms: number) => (ms / 1000) * pxPerSec;
  const pxToMs = (px: number) => (px / pxPerSec) * 1000;
  const width = Math.max(msToPx(total), 1);

  const clipCount = timeline.tracks.reduce((n, tk) => n + tk.clips.length, 0);

  /* ---- o arrasto (mover / aparar / transição), tudo por pointer ---- */
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = pxToMs(e.clientX - d.x0);
      // Encaixe: tolerância em ms derivada do zoom (mesmo "tamanho de dedo" em
      // qualquer escala). Segurar Alt DESLIGA o snap — a saída de emergência pra
      // posicionar no osso quando a marca atrapalha.
      const tol = e.altKey ? 0 : pxToMs(SNAP_PX);
      const s = useEditor.getState();
      const targets = snapTargets(s.history.present, d.id, s.playhead);

      if (d.kind === "move") {
        // Trilha de destino = a lane sob o dedo (senão, a de origem).
        let toTrack = d.trackId;
        for (const [id, el] of laneRefs.current) {
          const r = el.getBoundingClientRect();
          if (e.clientY >= r.top && e.clientY <= r.bottom) toTrack = id;
        }
        const raw = Math.max(0, d.start0 + delta);
        const snap = snapMove(raw, d.dur0, targets, tol);
        setSnapLine(snap.guide);
        doMoveClip(d.id, toTrack, snap.startMs);
      } else if (d.kind === "in") {
        const snap = snapValue(d.start0 + delta, targets, tol);
        setSnapLine(snap.target);
        doTrimEdge(d.id, "in", snap.value);
      } else if (d.kind === "out") {
        const snap = snapValue(d.end0 + delta, targets, tol);
        setSnapLine(snap.target);
        doTrimEdge(d.id, "out", snap.value);
      } else if (d.kind === "trans") {
        // Arrastar a alça pra ESQUERDA aumenta a sobreposição (transição).
        doSetTransition(d.id, d.trans0 - delta);
      }
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      setSnapLine(null);
      useEditor.getState().endEdit();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, pxPerSec]);

  const beginDrag = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    select(d.id);
    dragRef.current = d;
    setDragging(true);
    useEditor.getState().beginEdit();
  };

  const seekFromEvent = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    const x = e.clientX - el.getBoundingClientRect().left + el.scrollLeft;
    seek(pxToMs(x));
  };

  // O fantasma do ripple na borda IN (v0.4.1). No ripple, aparar pela esquerda
  // NÃO move a borda: o start fica colado, a alça apara a CABEÇA e a fila puxa —
  // correto, mas menos óbvio que a borda OUT (nada parece "andar" com o mouse).
  // Este fantasma dá corpo ao gesto: uma hachura do TAMANHO do trecho que já
  // saiu, encostada na borda fixa, com o delta em cima. A semântica não muda —
  // é só o gesto ganhando um rastro visível. Derivado no render (não em estado
  // próprio) porque cada movimento do arrasto já re-renderiza via store.
  const rippleGhost = (() => {
    const d = dragRef.current;
    if (!dragging || !d || d.kind !== "in" || !rippleMode) return null;
    const loc = locate(timeline, d.id);
    if (!loc) return null;
    const trimmedMs = d.end0 - d.start0 - clipDuration(loc.clip);
    if (trimmedMs <= 0) return null; // devolvendo cabeça: o conteúdo voltando já é o feedback
    return { trackId: loc.track.id, startMs: loc.clip.startMs, trimmedMs };
  })();

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
        <span className="muted small">{t("tl.stats", { n: clipCount, dur: formatDuration(total) })}</span>
        <span className="toolbar-fill" />
        <button onClick={doSplit} title={t("tl.split")} disabled={clipCount === 0}>
          <Icon name="split" /> {t("tl.split")}
        </button>
        <button onClick={() => doRemove()} title={t("tl.remove")} disabled={!selectedId}>
          <Icon name="trash" /> {t("tl.remove")}
        </button>
        <button
          className={rippleMode ? "on" : ""}
          onClick={() => setRippleMode(!rippleMode)}
          aria-pressed={rippleMode}
          title={rippleMode ? t("tl.rippleOn") : t("tl.rippleOff")}
        >
          <Icon name="ripple" /> {t("tl.ripple")}
        </button>
        <button onClick={() => doAddTrack("video")} title={t("tl.addVideo")}>
          <Icon name="addVideo" /> {t("tl.addVideo")}
        </button>
        <button onClick={() => doAddTrack("audio")} title={t("tl.addAudio")}>
          <Icon name="addAudio" /> {t("tl.addAudio")}
        </button>
        <span className="tl-zoom">
          <button onClick={() => setZoom(pxPerSec / 1.5)} title={t("tl.zoomOut")}>
            −
          </button>
          <button onClick={fit} title={t("tl.zoomFit")} disabled={total <= 0}>
            <Icon name="fit" />
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

          {/* trilhas empilhadas */}
          {timeline.tracks.map((track) => (
            <div
              key={track.id}
              className={`tl-lane ${track.kind}`}
              style={{ height: LANE_H }}
              ref={(el) => {
                if (el) laneRefs.current.set(track.id, el);
                else laneRefs.current.delete(track.id);
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) seekFromEvent(e);
              }}
            >
              <span className="tl-lane-badge muted"><Icon name={track.kind === "video" ? "addVideo" : "addAudio"} /></span>
              {track.clips.map((c, i) => (
                <ClipView
                  key={c.id}
                  clip={c}
                  track={track}
                  index={i}
                  msToPx={msToPx}
                  selected={selectedId === c.id}
                  gone={c.path ? missing.includes(c.path) : false}
                  strip={c.path ? thumbs[c.path] : undefined}
                  hasInfo={c.path ? !!media[c.path] : false}
                  onSelect={() => select(c.id)}
                  onBodyDown={(e) =>
                    beginDrag(e, {
                      kind: "move",
                      id: c.id,
                      x0: e.clientX,
                      start0: c.startMs,
                      dur0: clipDuration(c),
                      trackId: track.id,
                    })
                  }
                  onInDown={(e) =>
                    beginDrag(e, { kind: "in", id: c.id, x0: e.clientX, start0: c.startMs, end0: clipEnd(c) })
                  }
                  onOutDown={(e) =>
                    beginDrag(e, { kind: "out", id: c.id, x0: e.clientX, start0: c.startMs, end0: clipEnd(c) })
                  }
                  onTransDown={(e) =>
                    beginDrag(e, { kind: "trans", id: c.id, x0: e.clientX, trans0: overlapWithNext(track, i) })
                  }
                />
              ))}
              {/* o trecho que SAIU pela cabeça durante o ripple na borda IN */}
              {rippleGhost && rippleGhost.trackId === track.id ? (
                <div
                  className="tl-ripple-ghost"
                  style={{
                    left: msToPx(rippleGhost.startMs) - msToPx(rippleGhost.trimmedMs),
                    width: msToPx(rippleGhost.trimmedMs),
                  }}
                >
                  <em>−{formatDuration(rippleGhost.trimmedMs)}</em>
                </div>
              ) : null}
            </div>
          ))}

          {/* guia de encaixe: uma linha fina na marca onde a borda grudou */}
          {dragging && snapLine !== null ? (
            <div className="tl-snapline" style={{ left: msToPx(snapLine) }} />
          ) : null}

          {/* playhead por cima de tudo */}
          <div className="tl-playhead" style={{ left: msToPx(playhead) }}>
            <i />
          </div>
        </div>
      </div>

      <div className="tl-foot muted small">{clipCount > 0 ? t("tl.dragHint2") : t("empty.tip")}</div>
    </div>
  );
}

interface ClipViewProps {
  clip: Clip;
  track: Track;
  index: number;
  msToPx: (ms: number) => number;
  selected: boolean;
  gone: boolean;
  strip: { timesMs: number[]; urls: string[] } | undefined;
  hasInfo: boolean;
  onSelect: () => void;
  onBodyDown: (e: React.PointerEvent) => void;
  onInDown: (e: React.PointerEvent) => void;
  onOutDown: (e: React.PointerEvent) => void;
  onTransDown: (e: React.PointerEvent) => void;
}

/** Um clipe na régua: mídia (miniaturas) ou título (chip de texto). */
function ClipView(p: ClipViewProps) {
  const { clip: c, track, index, msToPx } = p;
  const w = msToPx(clipDuration(c));
  const left = msToPx(c.startMs);
  const overlap = overlapWithNext(track, index);

  const cls = [
    "tl-clip",
    isTitle(c) ? "title" : "media",
    p.selected ? "sel" : "",
    p.gone ? "gone" : "",
    c.muted ? "muted-clip" : "",
  ]
    .join(" ")
    .trim();

  const slots = Math.max(1, Math.round(w / THUMB_W));

  return (
    <div
      className={cls}
      style={{ width: w, left }}
      onClick={(e) => {
        e.stopPropagation();
        p.onSelect();
      }}
      onPointerDown={p.onBodyDown}
      title={isTitle(c) ? c.title!.text : baseName(c.path ?? "")}
    >
      {isMedia(c) ? (
        <div className="tl-thumbs" aria-hidden>
          {p.strip && p.strip.urls.length > 0
            ? Array.from({ length: slots }, (_, k) => {
                const at = (c.srcIn ?? 0) + (clipDuration(c) * (2 * k + 1)) / (2 * slots);
                const idx = nearestThumb(p.strip!.timesMs, at);
                return <img key={k} src={p.strip!.urls[idx]} alt="" draggable={false} />;
              })
            : null}
        </div>
      ) : (
        <div className="tl-title-chip" aria-hidden>
          <span>{c.title!.text || "—"}</span>
        </div>
      )}

      <div className="tl-clip-label">
        <span>{isTitle(c) ? `“${c.title!.text}”` : baseName(c.path ?? "")}</span>
        <span className="muted">{formatDuration(clipDuration(c))}</span>
        {isMedia(c) && p.hasInfo && !p.strip ? <span className="muted">· {t("tl.noThumbs")}</span> : null}
      </div>

      {/* alça de aparar início */}
      <span className="tl-handle in" onPointerDown={p.onInDown} onClick={(e) => e.stopPropagation()} title={t("clip.trimIn")} />
      {/* alça de aparar fim */}
      <span className="tl-handle out" onPointerDown={p.onOutDown} onClick={(e) => e.stopPropagation()} title={t("clip.trimOut")} />
      {/* alça de transição (crossfade com o próximo) — só quando há um próximo */}
      {index < track.clips.length - 1 ? (
        <span
          className={`tl-handle trans ${overlap > 0 ? "on" : ""}`}
          onPointerDown={p.onTransDown}
          onClick={(e) => e.stopPropagation()}
          title={t("clip.transition")}
        >
          {overlap > 0 ? <em>{formatDuration(overlap)}</em> : null}
        </span>
      ) : null}
    </div>
  );
}
