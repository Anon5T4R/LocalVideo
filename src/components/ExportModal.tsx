import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import { type ExportPresetId, type PlanReason } from "../lib/args";
import { t } from "../lib/i18n";
import { formatDuration } from "../lib/probe";
import { baseName, dirName } from "../state/editor";
import { plannedDuration, useExport } from "../state/export";
import { useUi } from "../state/ui";

/**
 * O modal de exportar.
 *
 * O trabalho dele não é só disparar o ffmpeg: é **contar ao usuário o que vai
 * acontecer e por quê**, ANTES de acontecer. "Sai em 2 segundos, sem recodificar"
 * e "vai recodificar, senta que vai demorar" são as duas respostas honestas, e
 * saber qual é muda o que a pessoa faz da vida nos próximos minutos.
 */
export default function ExportModal() {
  const ex = useExport();
  const dur = plannedDuration();

  if (!ex.open) return null;

  const running = ex.phase === "cutting" || ex.phase === "joining" || ex.phase === "encoding";

  const pick = async () => {
    const picked = await saveDialog({
      defaultPath: ex.outPath ?? "montagem.mp4",
      filters: [{ name: t("proj.dlgVideo"), extensions: ["mp4", "mkv", "mov"] }],
    });
    if (picked) ex.setOutPath(picked);
  };

  return (
    <div className="modal-backdrop" onClick={() => !running && ex.close()}>
      <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("exp.title")}</h2>

        {ex.phase === "probing" ? (
          <p className="muted">{t("exp.probing")}</p>
        ) : ex.phase === "done" && ex.result ? (
          <Done />
        ) : (
          <>
            <PresetPicker />
            <PlanCard />

            <div className="field">
              <label>{t("exp.dest")}</label>
              <div className="dest-row">
                <span className="dest-path" title={ex.outPath ?? ""}>
                  {ex.outPath ? baseName(ex.outPath) : "—"}
                </span>
                <button onClick={() => void pick()} disabled={running}>
                  {t("exp.change")}
                </button>
              </div>
              <p className="muted small">{t("exp.neverOverwrite")}</p>
            </div>

            {running ? (
              <div className="prog">
                <div className="prog-track">
                  <div className="prog-fill" style={{ width: `${Math.round(ex.progress.frac * 100)}%` }} />
                </div>
                <div className="prog-line muted small">
                  <span>{t(`exp.phase.${ex.phase}` as "exp.phase.encoding")}</span>
                  <span className="tabnum">
                    {Math.round(ex.progress.frac * 100)}%
                    {ex.progress.etaSec !== null
                      ? ` · ${t("exp.eta", { time: formatDuration(ex.progress.etaSec * 1000) })}`
                      : ""}
                    {ex.progress.speed ? ` · ${ex.progress.speed}` : ""}
                  </span>
                </div>
              </div>
            ) : null}

            <div className="modal-actions">
              {running ? (
                <button className="danger" onClick={() => ex.cancel()}>
                  {t("exp.cancel")}
                </button>
              ) : (
                <>
                  <button onClick={() => ex.close()}>{t("dlg.cancel")}</button>
                  <button
                    className="primary"
                    onClick={() => void ex.run()}
                    disabled={!ex.plan || !ex.outPath}
                  >
                    {t("exp.go", { dur: formatDuration(dur) })}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** O seletor de preset: nomes que a pessoa entende ("YouTube 1080p") em vez de
 *  resolução/codec soltos. Muda o plano ao vivo (o cartão abaixo reage). */
function PresetPicker() {
  const ex = useExport();
  const running = ex.phase === "cutting" || ex.phase === "joining" || ex.phase === "encoding";
  const ids: ExportPresetId[] = ["source", "youtube1080", "vertical", "whatsapp", "quality"];
  return (
    <div className="field">
      <label>{t("exp.presetLabel")}</label>
      <select
        value={ex.preset}
        disabled={running}
        onChange={(e) => ex.setPreset(e.target.value as ExportPresetId)}
      >
        {ids.map((id) => (
          <option key={id} value={id}>
            {t(`exp.preset.${id}` as "exp.preset.source")}
          </option>
        ))}
      </select>
      <p className="muted small">{t(`exp.presetHint.${ex.preset}` as "exp.presetHint.source")}</p>
    </div>
  );
}

/** O cartão que explica o caminho escolhido. É o coração do modal. */
function PlanCard() {
  const ex = useExport();
  if (!ex.plan) return null;
  const copy = ex.plan.kind === "copy";

  return (
    <div className={`plan ${copy ? "plan-fast" : "plan-slow"}`}>
      <div className="plan-head">
        <span className="plan-icon" aria-hidden>
          {copy ? "⚡" : "🎞"}
        </span>
        <strong>{copy ? t("exp.planCopy") : t("exp.planEncode")}</strong>
      </div>
      <p className="muted small">{reasonText(ex.plan.reason)}</p>

      {/* O encosto só aparece quando REALMENTE muda o caminho — checkbox que não
          faz nada é pior que checkbox nenhum. E o desvio vai à mostra: mexer no
          corte de alguém pra ganhar tempo é troca que a pessoa tem que escolher. */}
      {ex.snapWouldHelp || ex.snap ? (
        <label className="snap">
          <input type="checkbox" checked={ex.snap} onChange={(e) => ex.setSnap(e.target.checked)} />
          <span>{t("exp.snap")}</span>
          <span className="muted small block">{t("exp.snapHint")}</span>
        </label>
      ) : null}
    </div>
  );
}

function Done() {
  const ex = useExport();
  if (!ex.result) return null;
  const { compiled, plan } = ex.result;
  const path = ex.result.path;
  const copy = plan?.kind === "copy";
  const doneWhy = compiled ? t("exp.doneCompile") : copy ? t("exp.doneCopy") : t("exp.doneEncode");

  // "Abrir vídeo": entrega o arquivo ao player padrão do SO. "Mostrar na pasta":
  // o reveal nativo abre o explorador COM o arquivo já selecionado; se ele
  // falhar (SO sem suporte, arquivo sumiu), cai pra só abrir a pasta que o
  // contém — melhor que não fazer nada. Só quando nem isso vai é que avisa.
  const openFile = () => {
    void openPath(path).catch(() => useUi.getState().pushToast("error", t("exp.openFailed")));
  };
  const revealFile = () => {
    void revealItemInDir(path).catch(() => {
      void openPath(dirName(path)).catch(() =>
        useUi.getState().pushToast("error", t("exp.openFailed")),
      );
    });
  };

  return (
    <div className="done">
      <div className="done-icon" aria-hidden>
        ✔
      </div>
      <h3>{t("exp.doneTitle")}</h3>
      <p className="dest-path" title={path}>
        {baseName(path)}
      </p>
      <p className="muted small">
        {doneWhy} {t("exp.doneTime", { time: formatDuration(ex.result.elapsedMs) })}
      </p>
      <div className="modal-actions done-actions">
        <button onClick={openFile}>{t("exp.openFile")}</button>
        <button onClick={revealFile}>{t("exp.revealFile")}</button>
        <button className="primary" onClick={() => ex.close()}>
          {t("dlg.ok")}
        </button>
      </div>
    </div>
  );
}

/**
 * O porquê, em linguagem de gente e no idioma da UI.
 *
 * O `planExport` devolve CÓDIGO + dados justamente pra esta tradução acontecer
 * aqui, e não lá: frase montada dentro da lógica vazaria português na tela de
 * quem usa em espanhol.
 */
function reasonText(r: PlanReason): string {
  switch (r.code) {
    case "copy-exact":
      return t("exp.whyCopyExact");
    case "copy-snapped":
      return t("exp.whyCopySnapped", { ms: Math.round(r.maxShiftMs) });
    case "encode-off-keyframe":
      return t("exp.whyOffKeyframe", {
        at: formatDuration(r.atMs),
        near: formatDuration(r.nearestMs),
        name: baseName(r.path),
      });
    case "encode-mixed-format":
      return t("exp.whyMixed");
    case "encode-no-keyframe-data":
      return t("exp.whyNoKeyframes", { name: baseName(r.path) });
    case "encode-multitrack":
      return t("exp.whyMultitrack");
    case "encode-preset":
      return t("exp.whyPreset", { preset: t(`exp.preset.${r.preset}` as "exp.preset.source") });
  }
}
