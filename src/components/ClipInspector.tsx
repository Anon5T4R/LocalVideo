import { useRef } from "react";

import { t } from "../lib/i18n";
import { formatDuration, formatSize } from "../lib/probe";
import {
  clipDuration,
  clipSpeed,
  isTitle,
  locate,
  overlapWithNext,
  srcOut,
  type Clip,
  type ColorAdjust,
  type CropRect,
  type Keyframe,
  type Located,
  type TitleAnchor,
  type Transform,
  type TransitionKind,
} from "../lib/timeline";
import { baseName, useEditor } from "../state/editor";
import type { MediaInfo } from "../lib/probe";

/**
 * O painel do clipe selecionado. Na v0.2 ele deixou de ser só "informação" pra
 * virar o **painel de propriedades**: volume, fade e opacidade pra clipes de
 * mídia; texto, fonte, cor, âncora e duração pra títulos. Cada mexida é um passo
 * de undo (via `doUpdateClip`).
 *
 * Os campos são `<input>`/`<select>`, então os atalhos do editor ficam calados
 * enquanto se digita (o `App` ignora tecla vinda de campo de texto) — dá pra
 * escrever um título com "S" e espaço sem cortar a timeline por baixo.
 *
 * **Os subcomponentes moram no NÍVEL DO MÓDULO, e isso não é estética** (v0.4.1):
 * eles viviam DENTRO do componente, então cada render criava tipos novos e o
 * React desmontava/remontava a subárvore inteira A CADA edição. O custo era
 * invisível no código e brutal na mão: o campo perdia o FOCO a cada tecla e um
 * arrasto de slider morria no primeiro tique (o elemento sob o dedo era
 * substituído no meio do gesto). Descoberto dirigindo a GUI, não lendo o fonte.
 */
export default function ClipInspector() {
  const timeline = useEditor((s) => s.history.present);
  const media = useEditor((s) => s.media);
  const selectedId = useEditor((s) => s.selectedId);
  const playhead = useEditor((s) => s.playhead);
  const doUpdateClip = useEditor((s) => s.doUpdateClip);
  const doSetSpeed = useEditor((s) => s.doSetSpeed);

  const loc = selectedId ? locate(timeline, selectedId) : null;

  if (!loc) {
    return (
      <div className="card">
        <div className="card-head">
          <strong>{t("clip.title")}</strong>
        </div>
        <p className="muted small">{t("clip.none")}</p>
      </div>
    );
  }

  const c = loc.clip;
  const title = isTitle(c);

  return (
    <div className="card inspector">
      <div className="card-head">
        <strong>{title ? t("clip.titleClip") : t("clip.title")}</strong>
        <span className="muted small tabnum">{formatDuration(clipDuration(c))}</span>
      </div>

      {title ? (
        <TitleFields c={c} doUpdateClip={doUpdateClip} />
      ) : (
        <MediaFields
          c={c}
          loc={loc}
          media={media}
          playhead={playhead}
          doUpdateClip={doUpdateClip}
          doSetSpeed={doSetSpeed}
        />
      )}
    </div>
  );
}

type UpdateClip = ReturnType<typeof useEditor.getState>["doUpdateClip"];

/**
 * Um ARRASTO de slider é UMA sessão de undo (v0.4.1). Herança da v0.3: cada
 * tique do `onChange` do range era um passo — arrastar o volume enchia o
 * histórico e o Ctrl+Z virava conta-gotas. É a MESMA classe de bug que o
 * arrasto de PiP na prévia já consertou, com a MESMA cura: `beginEdit` no
 * pointerdown, `endEdit` no pointerup/blur — o `doUpdateClip` já coalesce
 * dentro da sessão. O blur cobre o caso do ponteiro solto fora da janela.
 * Edições discretas (número, checkbox, select) seguem 1 passo cada.
 */
const sliderSession = {
  onPointerDown: () => useEditor.getState().beginEdit(),
  onPointerUp: () => useEditor.getState().endEdit(),
  onBlur: () => useEditor.getState().endEdit(),
};

/* ---------------- título ---------------- */
function TitleFields({ c, doUpdateClip }: { c: Clip; doUpdateClip: UpdateClip }) {
  const tp = c.title!;
  const set = (patch: Partial<typeof tp>) => doUpdateClip(c.id, { title: { ...tp, ...patch } });
  return (
    <div className="fields small">
      <label className="field">
        <span>{t("title.text")}</span>
        <input value={tp.text} onChange={(e) => set({ text: e.target.value })} maxLength={200} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>{t("title.size")}</span>
          <input
            type="number"
            min={8}
            max={400}
            value={tp.fontSizePx}
            onChange={(e) => set({ fontSizePx: clampNum(e.target.value, 8, 400, 48) })}
          />
        </label>
        <label className="field">
          <span>{t("title.color")}</span>
          <input type="color" value={hexOf(tp.color)} onChange={(e) => set({ color: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>{t("title.position")}</span>
        <select value={tp.anchor} onChange={(e) => set({ anchor: e.target.value as TitleAnchor })}>
          <option value="top">{t("title.top")}</option>
          <option value="center">{t("title.center")}</option>
          <option value="bottom">{t("title.bottom")}</option>
        </select>
      </label>
      <label className="field">
        <span>{t("title.duration")}</span>
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={(clipDuration(c) / 1000).toFixed(1)}
          onChange={(e) => doUpdateClip(c.id, { durationMs: Math.max(100, Math.round(parseFloat(e.target.value || "0.1") * 1000)) })}
        />
      </label>
      <Opacity c={c} doUpdateClip={doUpdateClip} />
    </div>
  );
}

/* ---------------- mídia ---------------- */
function MediaFields({
  c,
  loc,
  media,
  playhead,
  doUpdateClip,
  doSetSpeed,
}: {
  c: Clip;
  loc: Located;
  media: Record<string, MediaInfo>;
  playhead: number;
  doUpdateClip: UpdateClip;
  doSetSpeed: (id: string, speed: number) => void;
}) {
  const info = c.path ? media[c.path] : undefined;
  const vol = c.volume ?? 1;
  const hasAudio = info?.hasAudio ?? false;
  return (
    <div className="fields small">
      <div className="kv-list small">
        {kv(t("clip.file"), baseName(c.path ?? ""))}
        {kv(t("clip.window"), `${formatDuration(c.srcIn ?? 0)} → ${formatDuration(srcOut(c))}`)}
        {info ? (
          <>
            {kv(t("clip.res"), `${info.width}×${info.height}`)}
            {kv(t("clip.fps"), info.fps.toFixed(3).replace(/\.?0+$/, ""))}
            {kv(t("clip.codec"), info.videoCodec)}
            {kv(t("clip.audio"), hasAudio ? (info.audioCodec ?? "—") : t("clip.noAudio"))}
            {kv(t("clip.size"), formatSize(info.sizeBytes))}
          </>
        ) : null}
      </div>

      {/* Áudio: só faz sentido se o clipe tiver som. */}
      {hasAudio ? (
        <>
          <label className="field-check">
            <input type="checkbox" checked={!!c.muted} onChange={(e) => doUpdateClip(c.id, { muted: e.target.checked })} />
            <span>{t("clip.mute")}</span>
          </label>
          <label className="field">
            <span>
              {t("clip.volume")} <b className="tabnum">{Math.round(vol * 100)}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={vol}
              disabled={!!c.muted || !!c.volumeKeyframes}
              onChange={(e) => doUpdateClip(c.id, { volume: parseFloat(e.target.value) })}
              {...sliderSession}
            />
          </label>
          <Envelope
            c={c}
            doUpdateClip={doUpdateClip}
            which="volumeKeyframes"
            label={t("clip.kfVolume")}
            max={2}
            seed={[
              { t: 0, v: vol },
              { t: 1, v: vol },
            ]}
          />
          <div className="field-row">
            <label className="field">
              <span>{t("clip.fadeIn")}</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={((c.fadeInMs ?? 0) / 1000).toFixed(1)}
                onChange={(e) => doUpdateClip(c.id, { fadeInMs: secToMs(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>{t("clip.fadeOut")}</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={((c.fadeOutMs ?? 0) / 1000).toFixed(1)}
                onChange={(e) => doUpdateClip(c.id, { fadeOutMs: secToMs(e.target.value) })}
              />
            </label>
          </div>
        </>
      ) : (
        <p className="muted small">{t("clip.noAudioHint")}</p>
      )}

      <Opacity c={c} doUpdateClip={doUpdateClip} />
      <Envelope
        c={c}
        doUpdateClip={doUpdateClip}
        which="opacityKeyframes"
        label={t("clip.kfOpacity")}
        max={1}
        seed={[
          { t: 0, v: 0 },
          { t: 1, v: 1 },
        ]}
      />

      <Speed c={c} doSetSpeed={doSetSpeed} />
      <Transition c={c} loc={loc} doUpdateClip={doUpdateClip} />
      <Crop c={c} doUpdateClip={doUpdateClip} />
      <Motion c={c} doUpdateClip={doUpdateClip} />
      <Color c={c} doUpdateClip={doUpdateClip} />

      <button
        className="block"
        disabled={!info || (c.srcIn === 0 && srcOut(c) === info.durationMs && clipSpeed(c) === 1)}
        onClick={() => info && doUpdateClip(c.id, { srcIn: 0, durationMs: info.durationMs, speed: 1 })}
      >
        {t("clip.reset")}
      </button>
      {/* playhead na dica pra não sumir de vez com o contexto de tempo */}
      <p className="muted small">{t("clip.dragHint", { at: formatDuration(playhead) })}</p>
    </div>
  );
}

function Opacity({ c, doUpdateClip }: { c: Clip; doUpdateClip: UpdateClip }) {
  const op = c.opacity ?? 1;
  return (
    <label className="field">
      <span>
        {t("clip.opacity")} <b className="tabnum">{Math.round(op * 100)}%</b>
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={op}
        disabled={!!c.opacityKeyframes}
        onChange={(e) => doUpdateClip(c.id, { opacity: parseFloat(e.target.value) })}
        {...sliderSession}
      />
    </label>
  );
}

/* ---------------- velocidade (P3) ---------------- */
function Speed({ c, doSetSpeed }: { c: Clip; doSetSpeed: (id: string, speed: number) => void }) {
  const sp = clipSpeed(c);
  const opts = [0.25, 0.5, 1, 1.5, 2, 4];
  return (
    <div className="field">
      <span>
        {t("clip.speed")} <b className="tabnum">{sp}×</b>
      </span>
      <div className="seg">
        {opts.map((o) => (
          <button key={o} className={sp === o ? "on" : ""} onClick={() => doSetSpeed(c.id, o)}>
            {o}×
          </button>
        ))}
      </div>
      <span className="muted small">{t("clip.speedHint")}</span>
    </div>
  );
}

/* ---------------- transição com o próximo (v0.4.1) ---------------- */
function Transition({ c, loc, doUpdateClip }: { c: Clip; loc: Located; doUpdateClip: UpdateClip }) {
  // Só aparece quando a transição EXISTE: há um próximo clipe de mídia e a
  // sobreposição é positiva (a geometria é a transição — sem sobreposição não
  // há o que tipar). PiP entrando cai sempre no dissolve (ver compilador), aí
  // o seletor esconde em vez de oferecer opção que mentiria.
  const next = loc.track.clips[loc.ci + 1];
  const ov = overlapWithNext(loc.track, loc.ci);
  if (!next || next.path === undefined || next.transform || ov <= 0) return null;
  const kind: TransitionKind = c.transitionKind ?? "dissolve";
  return (
    <div className="fields">
      <label className="field">
        <span>
          {t("clip.transKind")} <b className="tabnum">{formatDuration(ov)}</b>
        </span>
        <select
          value={kind}
          onChange={(e) =>
            // Dissolve é o padrão de sempre: escolher ele REMOVE a chave (o
            // .tvproj não engorda com o valor implícito).
            doUpdateClip(c.id, {
              transitionKind:
                e.target.value === "dissolve" ? null : (e.target.value as TransitionKind),
            })
          }
        >
          <option value="dissolve">{t("trans.dissolve")}</option>
          <option value="wipe">{t("trans.wipe")}</option>
          <option value="slide">{t("trans.slide")}</option>
        </select>
      </label>
      <span className="muted small">{t("clip.transKindHint")}</span>
    </div>
  );
}

/* ---------------- recorte (P2) ---------------- */
function Crop({ c, doUpdateClip }: { c: Clip; doUpdateClip: UpdateClip }) {
  const cr = c.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const set = (patch: Partial<CropRect>) => doUpdateClip(c.id, { crop: { ...cr, ...patch } });
  return (
    <div className="fields">
      <div className="sec-head">
        <span className="muted small">{t("clip.crop")}</span>
        {c.crop ? (
          <button className="mini" onClick={() => doUpdateClip(c.id, { crop: null })}>
            {t("clip.resetFilter")}
          </button>
        ) : null}
      </div>
      <div className="field-row">
        <NumPct label={t("clip.cropX")} value={cr.x} onChange={(v) => set({ x: v })} />
        <NumPct label={t("clip.cropY")} value={cr.y} onChange={(v) => set({ y: v })} />
      </div>
      <div className="field-row">
        <NumPct label={t("clip.cropW")} value={cr.w} onChange={(v) => set({ w: v })} />
        <NumPct label={t("clip.cropH")} value={cr.h} onChange={(v) => set({ h: v })} />
      </div>
    </div>
  );
}

/* ---------------- PiP / transform (P2) ---------------- */
function Motion({ c, doUpdateClip }: { c: Clip; doUpdateClip: UpdateClip }) {
  const tr = c.transform;
  const set = (patch: Partial<Transform>) =>
    doUpdateClip(c.id, { transform: { ...(tr ?? { x: 0.6, y: 0.6, scale: 0.35 }), ...patch } });
  return (
    <div className="fields">
      <label className="field-check">
        <input
          type="checkbox"
          checked={!!tr}
          onChange={(e) =>
            doUpdateClip(c.id, {
              transform: e.target.checked ? { x: 0.6, y: 0.6, scale: 0.35 } : null,
            })
          }
        />
        <span>{t("clip.pipOn")}</span>
      </label>
      {tr ? (
        <>
          <span className="muted small">{t("clip.pipCanvasHint")}</span>
          <Slider label={t("clip.pipSize")} min={0.1} max={1} value={tr.scale} onChange={(v) => set({ scale: v })} />
          <Slider label={t("clip.pipX")} min={0} max={1} value={tr.x} onChange={(v) => set({ x: v })} />
          <Slider label={t("clip.pipY")} min={0} max={1} value={tr.y} onChange={(v) => set({ y: v })} />
        </>
      ) : null}
    </div>
  );
}

/* ---------------- cor / eq (P2) ---------------- */
function Color({ c, doUpdateClip }: { c: Clip; doUpdateClip: UpdateClip }) {
  const col: ColorAdjust = c.color ?? { brightness: 0, contrast: 1, saturation: 1 };
  const set = (patch: Partial<ColorAdjust>) => doUpdateClip(c.id, { color: { ...col, ...patch } });
  return (
    <div className="fields">
      <div className="sec-head">
        <span className="muted small">{t("clip.secColor")}</span>
        {c.color ? (
          <button className="mini" onClick={() => doUpdateClip(c.id, { color: null })}>
            {t("clip.resetFilter")}
          </button>
        ) : null}
      </div>
      <Slider label={t("clip.brightness")} min={-1} max={1} value={col.brightness} onChange={(v) => set({ brightness: v })} />
      <Slider label={t("clip.contrast")} min={0} max={2} value={col.contrast} onChange={(v) => set({ contrast: v })} />
      <Slider label={t("clip.saturation")} min={0} max={3} value={col.saturation} onChange={(v) => set({ saturation: v })} />
    </div>
  );
}

/* ---------------- envelope de keyframes (P4) ---------------- */
function Envelope({
  c,
  doUpdateClip,
  which,
  label,
  max,
  seed,
}: {
  c: Clip;
  doUpdateClip: UpdateClip;
  which: "opacityKeyframes" | "volumeKeyframes";
  label: string;
  max: number;
  seed: Keyframe[];
}) {
  const list = c[which];
  const on = !!list && list.length > 0;
  const set = (next: Keyframe[] | null) => doUpdateClip(c.id, { [which]: next });
  const edit = (i: number, patch: Partial<Keyframe>) =>
    set(list!.map((p, j) => (j === i ? { ...p, ...patch } : p)).sort((a, b) => a.t - b.t));
  return (
    <div className="fields">
      <label className="field-check">
        <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked ? seed : null)} />
        <span>{label}</span>
      </label>
      {on ? (
        <div className="kf-list">
          <EnvelopeGraph list={list!} max={max} onSet={set} />
          <span className="muted small">{t("clip.kfGraphHint")}</span>
          <span className="muted small">{t("clip.kfHint")}</span>
          {list!.map((p, i) => (
            <div className="kf-row" key={i}>
              <span className="muted small">{t("clip.kfTime")}</span>
              <input
                type="number"
                min={0}
                max={100}
                value={Math.round(p.t * 100)}
                onChange={(e) => edit(i, { t: clamp01(parseFloat(e.target.value) / 100) })}
              />
              <span className="muted small">% · {t("clip.kfValue")}</span>
              <input
                type="number"
                min={0}
                max={Math.round(max * 100)}
                value={Math.round(p.v * 100)}
                onChange={(e) => edit(i, { v: clampTo(parseFloat(e.target.value) / 100, max) })}
              />
              <span className="muted small">%</span>
              <button
                className="mini"
                disabled={list!.length <= 2}
                onClick={() => set(list!.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="mini"
            onClick={() => set([...list!, { t: 0.5, v: max / 2 }].sort((a, b) => a.t - b.t))}
          >
            {t("clip.kfAdd")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * O mini-gráfico do envelope (v0.4.1). A lista numérica t%→v% funciona mas
 * não se VÊ — um envelope é uma curva, e curva se lê (e se edita) no olho.
 * Clique no vazio ADICIONA um ponto ali (passo discreto de undo); arrastar um
 * ponto o MOVE, coalescido numa sessão só (`beginEdit`/`endEdit`, como os
 * sliders). A lista numérica continua embaixo pra quem quer precisão.
 *
 * Durante o arrasto o `t` fica GRAMPEADO entre os vizinhos: o `edit` da lista
 * reordena por `t`, e um ponto cruzando o vizinho no meio do arrasto trocaria
 * de índice — o dedo passaria a arrastar OUTRO ponto. Grampear preserva o
 * índice e o gesto.
 */
function EnvelopeGraph(props: { list: Keyframe[]; max: number; onSet: (next: Keyframe[]) => void }) {
  const W = 100; // espaço de coordenadas do viewBox (t 0..1 → x 0..100)
  const H = 40;
  const svgRef = useRef<SVGSVGElement>(null);
  const dragIdx = useRef<number | null>(null);
  const pts = [...props.list].sort((a, b) => a.t - b.t);

  const toX = (p: Keyframe) => p.t * W;
  const toY = (p: Keyframe) => (1 - clampTo(p.v, props.max) / props.max) * H;
  /** O (t,v) sob o ponteiro, no espaço do envelope. */
  const fromEvent = (e: React.PointerEvent): Keyframe => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      t: clamp01((e.clientX - r.left) / Math.max(1, r.width)),
      v: clampTo((1 - (e.clientY - r.top) / Math.max(1, r.height)) * props.max, props.max),
    };
  };

  // A curva desenhada = a curva EXPORTADA: fora das pontas o envelope prende
  // no primeiro/último valor (mesma regra do envelopeExpr/envelopeAt).
  const line = [
    `0,${toY(pts[0]).toFixed(2)}`,
    ...pts.map((p) => `${toX(p).toFixed(2)},${toY(p).toFixed(2)}`),
    `${W},${toY(pts[pts.length - 1]).toFixed(2)}`,
  ].join(" ");

  return (
    <svg
      ref={svgRef}
      className="kf-graph"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onPointerDown={(e) => props.onSet([...pts, fromEvent(e)].sort((a, b) => a.t - b.t))}
    >
      <polyline className="kf-line" points={line} />
      {pts.map((p, i) => (
        // Dois círculos por ponto: o de cima é o ALVO (maior, invisível — no
        // viewBox esticado um r pequeno vira alvo de 4px, ninguém acerta) e o
        // de baixo é o desenho.
        <g key={i}>
          <circle className="kf-pt" cx={toX(p)} cy={toY(p)} r={2.2} />
          <circle
            className="kf-hit"
            cx={toX(p)}
            cy={toY(p)}
            r={6}
            onPointerDown={(e) => {
              e.stopPropagation();
              dragIdx.current = i;
              useEditor.getState().beginEdit();
              // A captura vem POR ÚLTIMO e blindada: se falhar (ponteiro já
              // morto, edge case de stylus), o arrasto ainda começa — só perde
              // o "seguir fora do elemento", não o gesto inteiro.
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* sem captura: o move ainda chega enquanto o dedo estiver em cima */
              }
            }}
            onPointerMove={(e) => {
              if (dragIdx.current !== i) return;
              const raw = fromEvent(e);
              const lo = i > 0 ? pts[i - 1].t + 0.001 : 0;
              const hi = i < pts.length - 1 ? pts[i + 1].t - 0.001 : 1;
              const moved = { t: Math.min(hi, Math.max(lo, raw.t)), v: raw.v };
              props.onSet(pts.map((q, j) => (j === i ? moved : q)));
            }}
            onPointerUp={() => {
              dragIdx.current = null;
              useEditor.getState().endEdit();
            }}
          />
        </g>
      ))}
    </svg>
  );
}

/** Slider genérico com rótulo e valor à mostra (0..1 vira %). */
function Slider(props: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span>
        {props.label} <b className="tabnum">{props.value.toFixed(2)}</b>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={0.02}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        {...sliderSession}
      />
    </label>
  );
}

/** Campo numérico em porcentagem (0..1 armazenado, 0..100 mostrado). */
function NumPct(props: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        min={0}
        max={100}
        value={Math.round(props.value * 100)}
        onChange={(e) => props.onChange(clamp01(parseFloat(e.target.value) / 100))}
      />
    </label>
  );
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
function clampTo(n: number, max: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
}

function kv(label: string, value: string) {
  return (
    <div className="kv">
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function clampNum(v: string, lo: number, hi: number, dflt: number): number {
  const n = Math.round(parseFloat(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

function secToMs(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

/** O `<input type=color>` só aceita `#rrggbb`. Nomes ("white") caem no branco. */
function hexOf(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#ffffff";
}
