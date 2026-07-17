import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";

import ClipInspector from "./components/ClipInspector";
import ExportModal from "./components/ExportModal";
import Preview from "./components/Preview";
import SettingsModal from "./components/SettingsModal";
import Timeline from "./components/Timeline";
import Toasts from "./components/Toasts";
import { t } from "./lib/i18n";
import { stepFrames } from "./lib/probe";
import { baseVideoTrack, clipCount, timelineDuration, timeToClip } from "./lib/timeline";
import { baseName, useEditor } from "./state/editor";
import { useExport } from "./state/export";
import { useUi } from "./state/ui";

const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "mpg", "mpeg", "wmv", "ts", "flv"];

export default function App() {
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const ed = useEditor();
  const [dropping, setDropping] = useState(false);
  /** Uma ação represada esperando o usuário decidir o que fazer com o projeto
   *  não salvo. `null` = não há diálogo aberto. */
  const [pending, setPending] = useState<null | (() => void)>(null);

  useEffect(() => {
    void ed.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const empty = clipCount(ed.history.present) === 0;

  /* ---------------- arquivos ---------------- */

  const pickAndImport = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: t("proj.dlgVideo"), extensions: VIDEO_EXT }],
    });
    if (!picked) return;
    await ed.importPaths(Array.isArray(picked) ? picked : [picked]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed]);

  const doSave = useCallback(
    async (forceAsk: boolean) => {
      let path = ed.projectPath;
      if (!path || forceAsk) {
        const picked = await saveDialog({
          defaultPath: path ?? "projeto.tvproj",
          filters: [{ name: t("proj.dlgProject"), extensions: ["tvproj"] }],
        });
        if (!picked) return false;
        path = picked;
      }
      await ed.saveProject(path);
      return true;
    },
    [ed],
  );

  const doOpen = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: t("proj.dlgProject"), extensions: ["tvproj"] }],
    });
    if (typeof picked === "string") await ed.openProject(picked);
  }, [ed]);

  /** Marcadores → cortes. Ver o estado real da ponte com o LocalRecord no
   *  cabeçalho de `lib/markers.ts` (spoiler: o Record ainda não os exporta). */
  const doImportMarkers = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: t("mk.dlgMarkers"), extensions: ["json"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const json = await invoke<string>("project_open", { path: picked });
      useEditor.getState().importMarkers(json);
    } catch {
      useUi.getState().pushToast("error", t("mk.corrupt"));
    }
  }, []);

  /** Nunca perder trabalho: qualquer coisa que jogue a timeline fora passa por
   *  aqui primeiro. Sem projeto sujo, segue direto — o diálogo não aparece à toa. */
  const guard = useCallback(
    (action: () => void) => {
      if (!ed.dirty || timelineDuration(ed.history.present) === 0) action();
      else setPending(() => action);
    },
    [ed.dirty, ed.history],
  );

  /* ---------------- arrastar e soltar ---------------- */

  // O handler do drop vive num ref pra que o listener possa ser registrado UMA
  // vez só. Antes ele dependia de `guard`, que muda a cada tecla dada na
  // timeline (`ed.dirty`/`ed.history` entram nas deps dele) — ou seja, o efeito
  // re-rodava o tempo todo, e cada re-rodada era um sorteio pra vazar listener.
  const handleDrop = (e: DragDropEvent) => {
    if (e.type === "over") setDropping(true);
    else if (e.type === "leave") setDropping(false);
    else if (e.type === "drop") {
      setDropping(false);
      const paths = e.paths.filter((p) =>
        VIDEO_EXT.includes(p.split(".").pop()?.toLowerCase() ?? ""),
      );
      const proj = e.paths.find((p) => p.toLowerCase().endsWith(".tvproj"));
      if (proj) guard(() => void useEditor.getState().openProject(proj));
      else if (paths.length > 0) void useEditor.getState().importPaths(paths);
    }
  };
  const onDrop = useRef(handleDrop);
  // Atualizar o ref em efeito, não no meio do render: render tem que ser puro
  // (o React pode render e jogar fora o resultado).
  useEffect(() => {
    onDrop.current = handleDrop;
  });

  useEffect(() => {
    // O drop vem do WEBVIEW do Tauri (o `drop` do DOM não entrega caminho de
    // arquivo — só um File sem path, que o ffmpeg não sabe abrir).
    let cancelled = false;
    let un: (() => void) | undefined;
    try {
      void getCurrentWebview()
        .onDragDropEvent((e) => onDrop.current?.(e.payload))
        .then((f) => {
          // O GOTCHA que fazia o app importar o MESMO arquivo duas/três vezes:
          // `un` só existe quando esta promessa resolve. Se a limpeza do efeito
          // correu antes disso, ela via `un === undefined`, não desregistrava
          // nada, e o listener ficava órfão pra sempre — invisível, porque
          // ninguém mais tinha a alça dele. Dois órfãos = um drop importando o
          // arquivo duas vezes = dois toasts idênticos na cara do usuário.
          // Chegando tarde, desregistra na hora em vez de guardar a alça.
          if (cancelled) f();
          else un = f;
        })
        .catch(() => {
          /* fora do Tauri não há drop nativo */
        });
    } catch {
      // `getCurrentWebview()` estoura na hora fora do Tauri (não há
      // `__TAURI_INTERNALS__`). Sem este try, o smoke no navegador — o cheque de
      // tema/idioma do padrão da suíte — morreria na tela branca.
    }
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  /* ---------------- atalhos (o que faz parecer NLE) ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Nunca roubar tecla de campo de texto (o Espaço tem que digitar espaço).
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;

      // Com um modal aberto, os atalhos do editor ficam calados: `S` não pode
      // cortar a timeline por trás do diálogo de exportar, nem `Del` sumir com o
      // clipe que a pessoa está prestes a exportar.
      const modal = useExport.getState().open || useUi.getState().settingsOpen || pending !== null;
      if (modal) return;

      const s = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        s.doUndo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        s.doRedo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave(e.shiftKey);
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        guard(() => void doOpen());
      } else if (mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        void pickAndImport();
      } else if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        if (!empty) void useExport.getState().openDialog();
      } else if (e.key === " ") {
        e.preventDefault();
        s.setPlaying(!s.playing);
      } else if (e.key.toLowerCase() === "j") {
        // J/K/L: o trio de atalhos que todo NLE tem, e o dedo de quem edita já
        // sabe de cor. J = ré, K = pausa, L = frente; repetir J ou L acelera.
        e.preventDefault();
        s.nudgeRate(-1);
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.setPlaying(false);
      } else if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        s.nudgeRate(1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        // Passo de UM QUADRO, na taxa do clipe que está debaixo do playhead —
        // não numa taxa média inventada. Com Shift, um segundo.
        const hit = timeToClip(baseVideoTrack(s.history.present), s.playhead);
        const fps = hit ? (s.media[hit.clip.path!]?.fps ?? 30) : 30;
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const dur = timelineDuration(s.history.present);
        s.setPlaying(false);
        s.seek(
          e.shiftKey
            ? Math.max(0, Math.min(s.playhead + dir * 1000, dur))
            : stepFrames(s.playhead, dir, fps, dur),
        );
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        s.doSplit();
      } else if (e.key.toLowerCase() === "t") {
        // T = soltar um título no playhead (na trilha base).
        e.preventDefault();
        s.doAddTitle();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        s.doRemove();
      } else if (e.key === "Home") {
        e.preventDefault();
        s.seek(0);
      } else if (e.key === "End") {
        e.preventDefault();
        s.seek(timelineDuration(s.history.present));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doOpen, doSave, guard, pickAndImport, empty, pending]);

  /* ---------------- render ---------------- */

  const title = ed.projectPath ? baseName(ed.projectPath) : t("top.untitled");

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">LocalVideo</span>
        <span className="muted tagline">{t("top.tagline")}</span>
        <span className="proj-name" title={ed.projectPath ?? ""}>
          {title}
          {ed.dirty ? (
            <b className="dirty-dot" title={t("top.unsavedMark")}>
              •
            </b>
          ) : null}
        </span>

        <span className="toolbar-fill" />

        <button onClick={() => void pickAndImport()} disabled={ed.importing || !ed.ffmpegOk}>
          {ed.importing ? t("top.importing") : `＋ ${t("top.import")}`}
        </button>
        <button onClick={() => guard(() => ed.newProject())}>{t("top.new")}</button>
        <button onClick={() => guard(() => void doOpen())}>{t("top.open")}</button>
        <button onClick={() => void doSave(false)} disabled={empty}>
          {t("top.save")}
        </button>
        <button
          onClick={() => ed.doAddTitle()}
          disabled={empty}
          title={`${t("title.add")} (T)`}
        >
          T＋
        </button>
        <button onClick={() => void doImportMarkers()} disabled={empty} title={t("mk.import")}>
          ⚑
        </button>
        <button
          className="primary"
          onClick={() => void useExport.getState().openDialog()}
          disabled={empty || !ed.ffmpegOk}
          title={`${t("sc.export")} (Ctrl+E)`}
        >
          ⇪ {t("top.export")}
        </button>
        <button onClick={() => ed.doUndo()} disabled={!ed.canUndo()} title={`${t("top.undo")} (Ctrl+Z)`}>
          ↺
        </button>
        <button onClick={() => ed.doRedo()} disabled={!ed.canRedo()} title={`${t("top.redo")} (Ctrl+Y)`}>
          ↻
        </button>
        <button onClick={() => setSettingsOpen(true)} title={t("top.settingsTitle")}>
          ⚙
        </button>
      </div>

      {!ed.ffmpegOk ? <div className="banner">⚠ {t("warn.noFfmpeg")}</div> : null}
      {ed.missing.length > 0 ? (
        <div className="banner">
          ⚠ {t("warn.missing", { n: ed.missing.length })}{" "}
          <span className="muted">{t("warn.missingHint")}</span>
        </div>
      ) : null}

      {empty ? (
        <div className={`empty ${dropping ? "dropping" : ""}`}>
          <div className="empty-box">
            <div className="empty-icon" aria-hidden>
              🎬
            </div>
            <h2>{dropping ? t("empty.dropNow") : t("empty.title")}</h2>
            <p className="muted">{t("empty.hint")}</p>
            <button className="primary" onClick={() => void pickAndImport()} disabled={!ed.ffmpegOk}>
              {t("empty.import")}
            </button>
            <ul className="shortcuts muted small">
              <li>
                <kbd>{t("sc.spaceKey")}</kbd> {t("sc.play")}
              </li>
              <li>
                <kbd>{t("sc.arrowsKey")}</kbd> {t("sc.step")}
              </li>
              <li>
                <kbd>S</kbd> {t("sc.split")}
              </li>
              <li>
                <kbd>T</kbd> {t("sc.addTitle")}
              </li>
              <li>
                <kbd>Del</kbd> {t("sc.remove")}
              </li>
              <li>
                <kbd>Ctrl+Z</kbd> {t("sc.undo")} · <kbd>Ctrl+Y</kbd> {t("sc.redo")}
              </li>
            </ul>
            <p className="muted small">{t("empty.tip")}</p>
          </div>
        </div>
      ) : (
        <>
          <div className={`grid ${dropping ? "dropping" : ""}`}>
            <Preview />
            <ClipInspector />
          </div>
          <Timeline />
        </>
      )}

      {pending ? (
        <div className="modal-backdrop" onClick={() => setPending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t("unsaved.title")}</h2>
            <p className="muted">{t("unsaved.body")}</p>
            <div className="modal-actions">
              <button onClick={() => setPending(null)}>{t("dlg.cancel")}</button>
              <button
                className="danger"
                onClick={() => {
                  const go = pending;
                  setPending(null);
                  go();
                }}
              >
                {t("unsaved.discard")}
              </button>
              <button
                className="primary"
                onClick={() => {
                  const go = pending;
                  void doSave(false).then((ok) => {
                    // Só descarta se o save REALMENTE aconteceu: cancelar o
                    // diálogo de salvar não pode custar o trabalho do usuário.
                    if (!ok) return;
                    setPending(null);
                    go();
                  });
                }}
              >
                {t("unsaved.save")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ExportModal />
      <SettingsModal />
      <Toasts />
    </div>
  );
}
