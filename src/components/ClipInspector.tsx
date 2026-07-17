import { t } from "../lib/i18n";
import { formatDuration, formatSize } from "../lib/probe";
import { clipDuration, isTitle, locate, srcOut, type TitleAnchor } from "../lib/timeline";
import { baseName, useEditor } from "../state/editor";

/**
 * O painel do clipe selecionado. Na v0.2 ele deixou de ser só "informação" pra
 * virar o **painel de propriedades**: volume, fade e opacidade pra clipes de
 * mídia; texto, fonte, cor, âncora e duração pra títulos. Cada mexida é um passo
 * de undo (via `doUpdateClip`).
 *
 * Os campos são `<input>`/`<select>`, então os atalhos do editor ficam calados
 * enquanto se digita (o `App` ignora tecla vinda de campo de texto) — dá pra
 * escrever um título com "S" e espaço sem cortar a timeline por baixo.
 */
export default function ClipInspector() {
  const timeline = useEditor((s) => s.history.present);
  const media = useEditor((s) => s.media);
  const selectedId = useEditor((s) => s.selectedId);
  const playhead = useEditor((s) => s.playhead);
  const doUpdateClip = useEditor((s) => s.doUpdateClip);

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

      {title ? <TitleFields /> : <MediaFields />}
    </div>
  );

  /* ---------------- título ---------------- */
  function TitleFields() {
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
        <Opacity />
      </div>
    );
  }

  /* ---------------- mídia ---------------- */
  function MediaFields() {
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
                disabled={!!c.muted}
                onChange={(e) => doUpdateClip(c.id, { volume: parseFloat(e.target.value) })}
              />
            </label>
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

        <Opacity />

        <button
          className="block"
          disabled={!info || (c.srcIn === 0 && srcOut(c) === info.durationMs)}
          onClick={() => info && doUpdateClip(c.id, { srcIn: 0, durationMs: info.durationMs })}
        >
          {t("clip.reset")}
        </button>
        {/* playhead na dica pra não sumir de vez com o contexto de tempo */}
        <p className="muted small">{t("clip.dragHint", { at: formatDuration(playhead) })}</p>
      </div>
    );
  }

  function Opacity() {
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
          onChange={(e) => doUpdateClip(c.id, { opacity: parseFloat(e.target.value) })}
        />
      </label>
    );
  }
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
