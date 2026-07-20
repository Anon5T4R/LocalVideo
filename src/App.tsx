import { invoke } from "@tauri-apps/api/core";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import ClipInspector from "./components/ClipInspector";
import ContextMenu, { type MenuItem } from "./components/ContextMenu";
import ExportModal from "./components/ExportModal";
import HelpModal from "./components/HelpModal";
import MediaPool, { poolRectAt } from "./components/MediaPool";
import Preview from "./components/Preview";
import SettingsModal from "./components/SettingsModal";
import Timeline from "./components/Timeline";
import Toasts from "./components/Toasts";
import { t } from "./lib/i18n";
import { shouldIgnoreShortcut } from "./lib/keys";
import Icon from "./components/Icon";
import { stepFrames } from "./lib/probe";
import { baseVideoTrack, clipCount, timelineDuration, timeToClip } from "./lib/timeline";
import { baseName, useEditor } from "./state/editor";
import { useExport } from "./state/export";
import { useUi } from "./state/ui";

const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "mpg", "mpeg", "wmv", "ts", "flv"];

/**
 * O arquivo que o SO está arrastando está sobre o PAINEL de mídia?
 *
 * O drop nativo do Tauri não entrega alvo de DOM — só uma coordenada. E a
 * coordenada vem em pixels FÍSICOS (`PhysicalPosition`), enquanto o
 * `getBoundingClientRect` fala em pixels CSS: sem dividir pelo
 * `devicePixelRatio`, numa tela a 150% (o padrão do Windows em notebook) o ponto
 * cairia 1,5× mais pra direita e pra baixo do que o dedo está — o painel só
 * aceitaria drop no seu canto superior esquerdo, e o resto viraria import na
 * timeline "sem motivo".
 */
/** Há trabalho neste projeto — clipe na régua OU arquivo no pool. É o que
 *  decide se jogar o projeto fora (Novo/Abrir/fechar a janela) precisa perguntar
 *  antes. Num lugar só porque o `guard` e o `onCloseRequested` têm que
 *  concordar: se discordarem, um dos dois caminhos perde trabalho calado. */
function hasWork(s: { history: { present: Parameters<typeof timelineDuration>[0] }; media: object }): boolean {
  return timelineDuration(s.history.present) > 0 || Object.keys(s.media).length > 0;
}

function overPool(pos: { x: number; y: number } | undefined): boolean {
  if (!pos) return false;
  const dpr = window.devicePixelRatio || 1;
  return poolRectAt(pos.x / dpr, pos.y / dpr);
}

export default function App() {
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const poolOpen = useUi((s) => s.poolOpen);
  const ed = useEditor();
  /** Há um arquivo do SO pairando sobre a janela — e SOBRE ONDE. O alvo importa
   *  desde a v0.11: soltar no painel de mídia importa pro pool SEM criar clipe;
   *  soltar em qualquer outro lugar mantém o fluxo rápido de sempre (entra na
   *  timeline). `null` = não há nada pairando. */
  const [dropping, setDropping] = useState<null | "pool" | "app">(null);
  /** Uma ação represada esperando o usuário decidir o que fazer com o projeto
   *  não salvo. `null` = não há diálogo aberto. */
  const [pending, setPending] = useState<null | (() => void)>(null);

  useEffect(() => {
    void ed.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Não há CLIPE na timeline. É o que cala o exportar, o título e os
   *  marcadores — todos falam sobre a régua, não sobre o pool. */
  const empty = clipCount(ed.history.present) === 0;
  /**
   * Não há clipe NEM arquivo no pool: o projeto está de fato em branco, e é só
   * aí que a tela-cartaz ("sua timeline está vazia") aparece.
   *
   * A distinção nasceu com o painel (v0.11): soltar arquivos NELE importa sem
   * criar clipe, então passou a existir um projeto com cinco takes dentro e a
   * régua vazia. Com o critério antigo, o app responderia a esse import com a
   * tela de "importe um vídeo" — escondendo justamente os arquivos que a pessoa
   * acabou de trazer, e sem lugar de onde arrastá-los pra régua.
   */
  const blank = empty && Object.keys(ed.media).length === 0;

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
  const doImportSubtitles = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: t("sub.dlg"), extensions: ["srt", "vtt"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const raw = await invoke<string>("project_open", { path: picked });
      useEditor.getState().importSubtitles(raw);
    } catch {
      useUi.getState().pushToast("error", t("sub.empty"));
    }
  }, []);

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
      // "Não há nada a perder" passou a incluir o POOL (v0.11): antes o teste era
      // só a duração da timeline, então um projeto com dez arquivos importados e
      // a régua ainda vazia era tratado como projeto em branco — Ctrl+O jogava a
      // importação inteira fora sem perguntar nada.
      if (!ed.dirty || hasWork(ed) === false) action();
      else setPending(() => action);
    },
    [ed],
  );

  /* ---------------- arrastar e soltar ---------------- */

  // O handler do drop vive num ref pra que o listener possa ser registrado UMA
  // vez só. Antes ele dependia de `guard`, que muda a cada tecla dada na
  // timeline (`ed.dirty`/`ed.history` entram nas deps dele) — ou seja, o efeito
  // re-rodava o tempo todo, e cada re-rodada era um sorteio pra vazar listener.
  const handleDrop = (e: DragDropEvent) => {
    if (e.type === "over") setDropping(overPool(e.position) ? "pool" : "app");
    else if (e.type === "leave") setDropping(null);
    else if (e.type === "drop") {
      const onPool = overPool(e.position);
      setDropping(null);
      const paths = e.paths.filter((p) =>
        VIDEO_EXT.includes(p.split(".").pop()?.toLowerCase() ?? ""),
      );
      const proj = e.paths.find((p) => p.toLowerCase().endsWith(".tvproj"));
      // Projeto ganha de tudo, inclusive de cair no painel: soltar um `.tvproj`
      // só pode querer dizer "abra isto".
      if (proj) guard(() => void useEditor.getState().openProject(proj));
      // O ALVO decide o que acontece — é a única diferença entre os dois drops,
      // e é a que faz o painel valer a pena: soltar nele guarda pra depois.
      else if (paths.length > 0) void useEditor.getState().importPaths(paths, !onPool);
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

  /* ---------------- título da janela (taskbar) ---------------- */

  // O título nativo acompanha o projeto e o estado sujo — assim a barra de
  // tarefas diz QUAL projeto está aberto e se tem alteração pendente, sem abrir a
  // janela. (`core:window:allow-set-title` já está na capability.)
  useEffect(() => {
    const name = ed.projectPath ? baseName(ed.projectPath) : t("top.untitled");
    const win = `${ed.dirty ? "● " : ""}${name} — LocalVideo`;
    try {
      void getCurrentWindow().setTitle(win).catch(() => {});
    } catch {
      /* fora do Tauri não há janela */
    }
  }, [ed.projectPath, ed.dirty]);

  /* ---------------- fechar a janela sem perder trabalho ---------------- */

  // O `guard` acima cobre Novo/Abrir/soltar-projeto, mas NÃO o fechamento da
  // janela (o X, Alt+F4). Sem isto, fechar com cortes não salvos — ou no meio de
  // uma exportação — jogava o trabalho fora calado. Registrar `onCloseRequested`
  // transfere o fechar pro JS: por isso `core:window:allow-destroy` é obrigatória
  // (já está na capability). O `preventDefault` é SÍNCRONO (antes de qualquer
  // await) pra não correr com o fechamento; o `destroy` explícito só vem depois
  // da resposta. Diálogo indisponível nunca deixa o app impossível de fechar.
  useEffect(() => {
    let deciding = false;
    let cancelled = false;
    let un: (() => void) | undefined;
    const isExporting = () => {
      const p = useExport.getState().phase;
      return p === "cutting" || p === "joining" || p === "encoding";
    };
    try {
      void getCurrentWindow()
        .onCloseRequested(async (e) => {
          const exporting = isExporting();
          const s = useEditor.getState();
          const dirty = s.dirty && hasWork(s);
          if (!exporting && !dirty) return; // nada a perder: fecha normal
          e.preventDefault();
          if (deciding) return; // já há um diálogo aberto (clicou no X de novo)
          deciding = true;
          try {
            const leave = await ask(exporting ? t("close.exporting") : t("close.dirty"), {
              title: "LocalVideo",
              kind: "warning",
              okLabel: t("close.leave"),
              cancelLabel: t("dlg.cancel"),
            });
            if (leave) {
              if (isExporting()) useExport.getState().cancel();
              await getCurrentWindow().destroy();
            }
          } catch {
            await getCurrentWindow().destroy().catch(() => {});
          } finally {
            deciding = false;
          }
        })
        .then((f) => {
          // Mesmo cuidado do listener de drop: se a limpeza correu antes de a
          // promessa resolver, desregistra na hora em vez de vazar o listener.
          if (cancelled) f();
          else un = f;
        })
        .catch(() => {
          /* fora do Tauri não há janela pra interceptar */
        });
    } catch {
      /* `getCurrentWindow()` estoura fora do Tauri (smoke no navegador) */
    }
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  /* ---------------- atalhos (o que faz parecer NLE) ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
       * Campo de texto e controle acionável ficam com a tecla — a regra mora em
       * `lib/keys.ts` (pura e testada).
       *
       * Achado ao fechar o B9 (seções recolhíveis), MEDIDO no app rodando: com
       * um `<button>` focado, o Espaço caía no ramo `e.key === " "` lá embaixo,
       * que faz `preventDefault()` e toca/pausa. `preventDefault()` num keydown
       * de Espaço **cancela a ativação nativa do botão** — ou seja, TODO botão
       * do app estava morto pra quem navega por teclado, e ainda dava play sem
       * querer. Não era exclusivo das seções: valia pra topbar, barra da
       * timeline, tudo.
       */
      if (shouldIgnoreShortcut(e.target as Element | null, e.key)) return;

      // Com um modal aberto, os atalhos do editor ficam calados: `S` não pode
      // cortar a timeline por trás do diálogo de exportar, nem `Del` sumir com o
      // clipe que a pessoa está prestes a exportar.
      const ui = useUi.getState();
      const modal =
        useExport.getState().open ||
        ui.settingsOpen ||
        ui.menuOpen ||
        ui.confirmOpen ||
        ui.helpOpen ||
        pending !== null;
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
      } else if (mod && e.key.toLowerCase() === "d") {
        // Ctrl+D = duplicar o clipe selecionado. `preventDefault` obrigatório: no
        // navegador/webview esse atalho é "adicionar aos favoritos".
        e.preventDefault();
        s.doDuplicate();
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
      } else if (e.key === "?") {
        // A folha de atalhos. Checar o CARACTERE e não `Shift+/`: em teclado
        // ABNT2 (o do usuário) a interrogação sai de Shift+; e num alemão de
        // Shift+ß — casar pela tecla física deixaria o atalho fora do alcance
        // justamente de quem não usa layout americano.
        e.preventDefault();
        useUi.getState().setHelpOpen(true);
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

        {/* A topbar em GRUPOS (v0.7.1). Antes eram 11 botões numa fila só, sem
            separador e sem `nowrap`: a 1280px SEIS deles quebravam o rótulo em
            duas linhas e a barra ficava serrilhada — amadora antes de o usuário
            clicar em nada. Agora: Arquivo ▾ e Importar ▾ recolhem 7 botões em
            dois menus, os grupos ganham separador, e o Exportar fica isolado do
            outro lado como a ação primária que é. */}
        <MenuButton
          label={t("top.menuFile")}
          items={[
            { label: t("top.new"), hint: "", onClick: () => guard(() => ed.newProject()) },
            { label: t("top.open"), hint: "Ctrl+O", onClick: () => guard(() => void doOpen()) },
            // `blank` e não `empty`: um projeto que só tem o POOL cheio já tem o
            // que salvar (o `.tvproj` guarda o pool inteiro desde a v0.11) — e
            // era exatamente o trabalho que se perderia sem poder gravar.
            { label: t("top.save"), hint: "Ctrl+S", onClick: () => void doSave(false), disabled: blank, divider: true },
            { label: t("top.saveAs"), hint: "Ctrl+Shift+S", onClick: () => void doSave(true), disabled: blank },
          ]}
        />
        <MenuButton
          label={t("top.menuImport")}
          disabled={!ed.ffmpegOk}
          items={[
            {
              label: ed.importing ? t("top.importing") : t("top.importMedia"),
              hint: "Ctrl+I",
              onClick: () => void pickAndImport(),
              disabled: ed.importing || !ed.ffmpegOk,
            },
            { label: t("mk.import"), onClick: () => void doImportMarkers(), disabled: empty, divider: true },
            { label: t("sub.import"), onClick: () => void doImportSubtitles(), disabled: empty },
          ]}
        />
        <button onClick={() => ed.doAddTitle()} disabled={empty} title={`${t("title.add")} (T)`}>
          <Icon name="subtitle" /> {t("title.add")}
        </button>

        <span className="top-sep" aria-hidden />

        <button onClick={() => ed.doUndo()} disabled={!ed.canUndo()} title={`${t("top.undo")} (Ctrl+Z)`}>
          <Icon name="undo" label={t("top.undo")} />
        </button>
        <button onClick={() => ed.doRedo()} disabled={!ed.canRedo()} title={`${t("top.redo")} (Ctrl+Y)`}>
          <Icon name="redo" label={t("top.redo")} />
        </button>

        <span className="top-sep" aria-hidden />

        <button
          className="primary"
          onClick={() => void useExport.getState().openDialog()}
          disabled={empty || !ed.ffmpegOk}
          title={`${t("sc.export")} (Ctrl+E)`}
        >
          <Icon name="export" /> {t("top.export")}
        </button>
        <button onClick={() => setSettingsOpen(true)} title={t("top.settingsTitle")}>
          <Icon name="settings" label={t("top.settingsTitle")} />
        </button>
      </div>

      {!ed.ffmpegOk ? <div className="banner"><Icon name="warn" /> {t("warn.noFfmpeg")}</div> : null}
      {ed.missing.length > 0 ? (
        <div className="banner">
          <Icon name="warn" /> {t("warn.missing", { n: ed.missing.length })}{" "}
          <span className="muted">{t("warn.missingHint")}</span>
        </div>
      ) : null}

      {blank ? (
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
          {/* O painel entra como COLUNA do mesmo grid (e não como irmão do
              `.grid`) pra herdar de graça a cura da F1: o grid não rola, cada
              coluna rola por dentro. Um wrapper novo por fora traria de volta o
              workspace inteiro rolando — a causa nº1 do "tá estranho". */}
          <div className={`grid ${poolOpen ? "with-pool" : "with-pool-rail"} ${dropping === "app" ? "dropping" : ""}`}>
            <MediaPool osDropping={dropping === "pool"} />
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
      <HelpModal />
      <SettingsModal />
      <Toasts />
    </div>
  );
}

/**
 * Um botão de menu da topbar (Arquivo ▾, Importar ▾).
 *
 * Reusa o `ContextMenu` de propósito: ele já resolve o que todo menu erra —
 * fechar no clique fora, fechar no Esc e não vazar da tela. A única diferença é
 * a origem: aqui a posição vem do RETÂNGULO do botão (abre colado embaixo dele),
 * não do ponteiro.
 *
 * Enquanto está aberto, `menuOpen` no `ui` CALA os atalhos do editor — senão o
 * "S" de quem navega o menu com o teclado cortaria a timeline por baixo (o
 * mesmo gotcha que o modal de exportação já tinha resolvido).
 */
function MenuButton({
  label,
  items,
  disabled,
}: {
  label: string;
  items: MenuItem[];
  disabled?: boolean;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const setMenuOpen = useUi((s) => s.setMenuOpen);

  const close = useCallback(() => {
    setAt(null);
    setMenuOpen(false);
  }, [setMenuOpen]);

  return (
    <>
      <button
        ref={btnRef}
        className={`top-menu-btn ${at ? "on" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={() => {
          if (at) {
            close();
            return;
          }
          const r = btnRef.current?.getBoundingClientRect();
          setAt({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 });
          setMenuOpen(true);
        }}
      >
        {label} <span className="top-caret" aria-hidden>▾</span>
      </button>
      {at ? <ContextMenu x={at.x} y={at.y} items={items} onClose={close} /> : null}
    </>
  );
}
