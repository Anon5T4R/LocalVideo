import { t } from "../lib/i18n";
import { formatDuration, formatSize } from "../lib/probe";
import { clipDuration, timeToClip } from "../lib/timeline";
import { baseName, useEditor } from "../state/editor";

/**
 * O painel do clipe selecionado: o que este pedaço é, e as aparas exatas.
 *
 * A alça arrastada é boa pro gesto grosso; os botões daqui aparam no playhead,
 * que é o jeito de acertar o frame exato sem pulso de cirurgião.
 */
export default function ClipInspector() {
  const track = useEditor((s) => s.history.present);
  const media = useEditor((s) => s.media);
  const selectedId = useEditor((s) => s.selectedId);
  const playhead = useEditor((s) => s.playhead);
  const doTrim = useEditor((s) => s.doTrim);

  const clip = track.clips.find((c) => c.id === selectedId) ?? null;

  if (!clip) {
    return (
      <div className="card">
        <div className="card-head">
          <strong>{t("clip.title")}</strong>
        </div>
        <p className="muted small">{t("clip.none")}</p>
      </div>
    );
  }

  const info = media[clip.path];
  const hit = timeToClip(track, playhead);
  // Aparar no playhead só faz sentido se ele estiver DENTRO deste clipe.
  const inThis = hit?.clip.id === clip.id;
  const at = inThis ? hit!.srcTime : null;

  const row = (label: string, value: string) => (
    <div className="kv">
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  );

  return (
    <div className="card">
      <div className="card-head">
        <strong>{t("clip.title")}</strong>
        <span className="muted small tabnum">{formatDuration(clipDuration(clip))}</span>
      </div>

      <div className="kv-list small">
        {row(t("clip.file"), baseName(clip.path))}
        {row(
          t("clip.window"),
          `${formatDuration(clip.srcIn)} → ${formatDuration(clip.srcOut)}`,
        )}
        {info ? (
          <>
            {row(t("clip.res"), `${info.width}×${info.height}`)}
            {/* fps com 3 casas de propósito: 29,97 e 23,976 são exatamente o
                ponto onde arredondar pra "30" esconderia a verdade da mídia. */}
            {row(t("clip.fps"), info.fps.toFixed(3).replace(/\.?0+$/, ""))}
            {row(t("clip.codec"), info.videoCodec)}
            {row(t("clip.audio"), info.hasAudio ? (info.audioCodec ?? "—") : t("clip.noAudio"))}
            {row(t("clip.streams"), String(info.streamCount))}
            {row(t("clip.size"), formatSize(info.sizeBytes))}
          </>
        ) : null}
      </div>

      <div className="segmented">
        <button
          disabled={at === null || at <= clip.srcIn}
          onClick={() => at !== null && doTrim(clip.id, at, clip.srcOut)}
          title={t("clip.trimHint")}
        >
          ⇥ {t("clip.trimIn")}
        </button>
        <button
          disabled={at === null || at >= clip.srcOut}
          onClick={() => at !== null && doTrim(clip.id, clip.srcIn, at)}
          title={t("clip.trimHint")}
        >
          ⇤ {t("clip.trimOut")}
        </button>
        <button
          disabled={!info || (clip.srcIn === 0 && clip.srcOut === info.durationMs)}
          onClick={() => info && doTrim(clip.id, 0, info.durationMs)}
        >
          {t("clip.reset")}
        </button>
      </div>
    </div>
  );
}
