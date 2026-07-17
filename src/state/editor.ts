import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";

import { t } from "../lib/i18n";
import { applyMarkers, MarkerParseError, parseMarkers } from "../lib/markers";
import { thumbTimes, withFps, type MediaInfo, type RawMediaInfo } from "../lib/probe";
import { parseProject, ProjectParseError, serializeProject } from "../lib/project";
import {
  append,
  canRedo,
  canUndo,
  initHistory,
  move,
  newId,
  pushHistory,
  redo,
  remove,
  replacePresent,
  split,
  totalDuration,
  trim,
  undo,
  type History,
  type Track,
} from "../lib/timeline";
import { useUi } from "./ui";

/** Miniaturas de um arquivo: a tira inteira, extraída uma vez no import. */
export interface ThumbStrip {
  timesMs: number[];
  urls: string[];
}

/** Quantas miniaturas por arquivo. 16 é o ponto em que a régua já conta a
 *  história do vídeo sem o import virar uma espera. */
const THUMBS_PER_FILE = 16;

interface EditorState {
  history: History<Track>;
  media: Record<string, MediaInfo>;
  thumbs: Record<string, ThumbStrip>;
  /** Arquivos que o projeto cita mas sumiram do disco. */
  missing: string[];

  selectedId: string | null;
  playhead: number;
  playing: boolean;
  /**
   * Velocidade do play (J/K/L). Negativo = ré.
   * O `<video>` não toca pra trás — quem anda na ré é o playhead (ver `Preview`).
   */
  rate: number;
  /** Zoom da régua, em pixels por segundo. */
  pxPerSec: number;

  projectPath: string | null;
  dirty: boolean;
  importing: boolean;
  ffmpegOk: boolean;
  /** Há uma alça sendo arrastada agora? (coalesce do undo — ver `doTrim`) */
  trimming: boolean;
  /** Esta sessão de aparo já empilhou o estado de antes? */
  trimPushed: boolean;

  track: () => Track;
  duration: () => number;
  canUndo: () => boolean;
  canRedo: () => boolean;

  init: () => Promise<void>;
  importPaths: (paths: string[]) => Promise<void>;
  doSplit: () => void;
  doTrim: (id: string, srcIn: number, srcOut: number) => void;
  /** Abre uma sessão de aparo: o arrasto inteiro vira UM passo de undo. */
  beginTrim: () => void;
  endTrim: () => void;
  doMove: (id: string, toIndex: number) => void;
  doRemove: (id?: string) => void;
  doUndo: () => void;
  doRedo: () => void;

  select: (id: string | null) => void;
  seek: (ms: number) => void;
  setPlaying: (v: boolean) => void;
  /** J/L: `dir` -1 (ré) ou +1 (frente). Repetir acelera, como em NLE de verdade. */
  nudgeRate: (dir: -1 | 1) => void;
  setZoom: (pxPerSec: number) => void;

  importMarkers: (json: string) => void;

  newProject: () => void;
  openProject: (path: string) => Promise<void>;
  saveProject: (path: string) => Promise<void>;
}

/** Um erro do Rust vira frase de gente, no idioma da UI. Os comandos devolvem
 *  CÓDIGO curto ("no-video"); qualquer coisa fora da lista cai no genérico —
 *  jamais despejamos a string crua (nem stderr de ffmpeg) na tela. */
function humanError(e: unknown): string {
  const code = String(e);
  switch (code) {
    case "no-runtime":
      return t("err.noRuntime");
    case "no-video":
      return t("err.noVideo");
    case "probe-failed":
    case "bad-json":
      return t("err.probeFailed");
    case "thumbs-failed":
      return t("err.thumbsFailed");
    default:
      return t("err.generic");
  }
}

export const useEditor = create<EditorState>((set, get) => ({
  history: initHistory<Track>({ clips: [] }),
  media: {},
  thumbs: {},
  missing: [],
  selectedId: null,
  playhead: 0,
  playing: false,
  rate: 1,
  pxPerSec: 40,
  projectPath: null,
  dirty: false,
  importing: false,
  ffmpegOk: true,
  trimming: false,
  trimPushed: false,

  track: () => get().history.present,
  duration: () => totalDuration(get().history.present),
  canUndo: () => canUndo(get().history),
  canRedo: () => canRedo(get().history),

  init: async () => {
    try {
      set({ ffmpegOk: await invoke<boolean>("ffmpeg_ok") });
    } catch {
      // Fora do Tauri (npm run preview) não há runtime pra checar — não é erro
      // que valha assustar ninguém.
      set({ ffmpegOk: false });
    }
  },

  importPaths: async (paths) => {
    if (paths.length === 0) return;
    set({ importing: true });
    try {
      // ANTES de qualquer coisa render: o usuário escolheu estes arquivos, então
      // o protocolo `asset://` pode servi-los. Sem isto, vídeo fora do `$HOME`
      // (um `D:\`, por exemplo) volta 403 e a prévia fica preta. Ver o porquê do
      // desenho em `src-tauri/src/media.rs`, `allow_media`.
      await allowMedia(paths);
      for (const path of paths) {
        let info: MediaInfo;
        try {
          info = withFps(await invoke<RawMediaInfo>("probe", { path }));
        } catch (e) {
          // Um arquivo ruim no meio de dez não pode abortar os outros nove.
          useUi.getState().pushToast("error", `${baseName(path)} — ${humanError(e)}`);
          continue;
        }

        // O clipe entra INTEIRO (0..duração): importar não é editar. Quem corta
        // é o usuário, e o undo tem que ter pra onde voltar.
        const clip = { id: newId(), path, srcIn: 0, srcOut: info.durationMs };
        set((s) => ({
          media: { ...s.media, [path]: info },
          history: pushHistory(s.history, append(s.history.present, clip)),
          dirty: true,
          selectedId: clip.id,
        }));

        // Miniaturas depois de o clipe já estar na tela: a régua se preenche
        // sozinha. Travar a janela esperando o ffmpeg seria o oposto do combinado.
        void loadThumbs(path, info.durationMs);
      }
    } finally {
      set({ importing: false });
    }
  },

  doSplit: () => {
    const { history, playhead } = get();
    const next = split(history.present, playhead);
    if (next === history.present) return; // não-evento: nada de toast de erro
    set({ history: pushHistory(history, next), dirty: true });
  },

  doTrim: (id, srcIn, srcOut) => {
    const { history, media, trimming, trimPushed } = get();
    const clip = history.present.clips.find((c) => c.id === id);
    if (!clip) return;
    // O limite é a duração do ARQUIVO: aparar não pode inventar vídeo que não existe.
    const limit = media[clip.path]?.durationMs;
    const next = trim(history.present, id, srcIn, srcOut, limit);
    if (next === history.present) return;
    // Num arrasto, só o PRIMEIRO movimento empilha (guardando o estado de antes);
    // o resto troca o presente. Ver `replacePresent` pro porquê. Fora de arrasto
    // (os botões do inspetor), cada chamada é um passo — que é o certo.
    const first = !trimming || !trimPushed;
    set({
      history: first ? pushHistory(history, next) : replacePresent(history, next),
      dirty: true,
      trimPushed: true,
    });
    clampPlayhead(set, get);
  },

  beginTrim: () => set({ trimming: true, trimPushed: false }),
  endTrim: () => set({ trimming: false, trimPushed: false }),

  doMove: (id, toIndex) => {
    const { history } = get();
    const next = move(history.present, id, toIndex);
    if (next === history.present) return;
    set({ history: pushHistory(history, next), dirty: true });
  },

  doRemove: (id) => {
    const target = id ?? get().selectedId;
    if (!target) return;
    const { history } = get();
    const next = remove(history.present, target);
    if (next === history.present) return;
    set({
      history: pushHistory(history, next),
      dirty: true,
      selectedId: get().selectedId === target ? null : get().selectedId,
    });
    clampPlayhead(set, get);
  },

  doUndo: () => {
    const h = undo(get().history);
    if (h === get().history) return;
    set({ history: h, dirty: true });
    reconcileSelection(set, get);
  },

  doRedo: () => {
    const h = redo(get().history);
    if (h === get().history) return;
    set({ history: h, dirty: true });
    reconcileSelection(set, get);
  },

  select: (selectedId) => set({ selectedId }),
  seek: (ms) =>
    set({ playhead: Math.max(0, Math.min(Math.round(ms), totalDuration(get().history.present))) }),
  setPlaying: (playing) => set({ playing, rate: playing ? get().rate : 1 }),

  nudgeRate: (dir) => {
    const { playing, rate } = get();
    // Parado, o primeiro toque só começa a tocar naquele sentido.
    if (!playing) {
      set({ playing: true, rate: dir });
      return;
    }
    // Tocando no MESMO sentido: dobra (1→2→4→8, e para aí; acima disso o
    // `<video>` já não entrega áudio e vira só um borrão).
    if (Math.sign(rate) === dir) {
      set({ rate: Math.sign(rate) * Math.min(8, Math.abs(rate) * 2) });
      return;
    }
    // Sentido contrário: volta pra velocidade 1 daquele lado — é o que o dedo
    // espera (J depois de L não é "meia velocidade", é "pra trás").
    set({ rate: dir });
  },

  setZoom: (pxPerSec) => set({ pxPerSec: Math.max(4, Math.min(400, pxPerSec)) }),

  /**
   * Ponte com o LocalRecord: marcadores viram cortes.
   *
   * Nota importante sobre o estado real desta ponte: **o LocalRecord v0.1.2 não
   * exporta marcador nenhum hoje** (conferido no código dele — ver o cabeçalho
   * de `lib/markers.ts`). O que existe aqui é a ponta de cá: o LocalVideo lê um
   * JSON de marcadores simples, documentado lá. Nada foi inventado em nome dele.
   */
  importMarkers: (json) => {
    let file: ReturnType<typeof parseMarkers>;
    try {
      file = parseMarkers(json);
    } catch (e) {
      useUi
        .getState()
        .pushToast(
          "error",
          e instanceof MarkerParseError && e.message === "empty"
            ? t("mk.empty")
            : t("mk.corrupt"),
        );
      return;
    }

    const track = get().history.present;
    const paths = [...new Set(track.clips.map((c) => c.path))];

    // A qual arquivo os instantes se referem? O arquivo de marcadores pode
    // dizer. Se não disser e houver UM vídeo só na timeline, não há dúvida.
    // Com dois candidatos e nenhuma pista, **não se adivinha**: cortar o vídeo
    // errado é pior do que não cortar.
    const source = file.source ?? (paths.length === 1 ? paths[0] : null);
    if (!source) {
      useUi.getState().pushToast("error", t("mk.whichSource"));
      return;
    }
    if (!paths.includes(source)) {
      useUi.getState().pushToast("error", t("mk.sourceNotHere", { name: baseName(source) }));
      return;
    }

    const r = applyMarkers(track, source, file.markers);
    if (r.applied === 0) {
      useUi.getState().pushToast("info", t("mk.noneApplied"));
      return;
    }
    set({ history: pushHistory(get().history, r.track), dirty: true });
    useUi
      .getState()
      .pushToast(
        "ok",
        r.skipped > 0
          ? t("mk.appliedSome", { n: r.applied, skipped: r.skipped })
          : t("mk.applied", { n: r.applied }),
      );
  },

  newProject: () =>
    set({
      history: initHistory<Track>({ clips: [] }),
      media: {},
      thumbs: {},
      missing: [],
      selectedId: null,
      playhead: 0,
      playing: false,
      rate: 1,
      projectPath: null,
      dirty: false,
    }),

  openProject: async (path) => {
    let json: string;
    try {
      json = await invoke<string>("project_open", { path });
    } catch {
      useUi.getState().pushToast("error", t("proj.openFailed"));
      return;
    }

    let doc: ReturnType<typeof parseProject>;
    try {
      doc = parseProject(json);
    } catch (e) {
      const why =
        e instanceof ProjectParseError && e.message === "newer"
          ? t("proj.newer")
          : e instanceof ProjectParseError && e.message === "notOurs"
            ? t("proj.notOurs")
            : t("proj.corrupt");
      useUi.getState().pushToast("error", why);
      return;
    }

    // O .tvproj guarda CAMINHO, não vídeo. Se a mídia foi movida, o app diz —
    // não abre uma timeline de retângulos vazios fingindo que está tudo certo.
    const paths = [...new Set(doc.track.clips.map((c) => c.path))];
    let missing: string[] = [];
    try {
      const exists = await invoke<boolean[]>("paths_exist", { paths });
      missing = paths.filter((_, i) => !exists[i]);
    } catch {
      /* fora do Tauri: sem o que conferir */
    }

    // Abrir um projeto é o mesmo consentimento de importar: o usuário escolheu
    // este `.tvproj`, que cita estes vídeos. Só os que existem — não vale gastar
    // escopo com caminho que sumiu do disco.
    await allowMedia(paths.filter((p) => !missing.includes(p)));

    const media: Record<string, MediaInfo> = {};
    for (const [p, raw] of Object.entries(doc.media)) media[p] = withFps(raw);

    set({
      history: initHistory(doc.track),
      media,
      thumbs: {},
      missing,
      selectedId: null,
      playhead: 0,
      playing: false,
      projectPath: path,
      dirty: false,
    });

    for (const p of paths) {
      if (missing.includes(p)) continue;
      void loadThumbs(p, media[p]?.durationMs ?? 0);
    }
    if (missing.length > 0) {
      useUi.getState().pushToast("error", t("proj.missingMedia", { n: missing.length }));
    }
  },

  saveProject: async (path) => {
    const { history, media } = get();
    const raws: Record<string, RawMediaInfo> = {};
    for (const [p, info] of Object.entries(media)) {
      const { fps: _fps, ...raw } = info; // `fps` é derivado — não vai pro arquivo
      raws[p] = raw;
    }
    try {
      await invoke("project_save", {
        path,
        json: serializeProject(history.present, raws),
      });
      set({ projectPath: path, dirty: false });
      useUi.getState().pushToast("ok", t("proj.saved", { name: baseName(path) }));
    } catch {
      useUi.getState().pushToast("error", t("proj.saveFailed"));
    }
  },
}));

/**
 * Põe estes arquivos no escopo do protocolo de asset (ver `media::allow_media`).
 *
 * Falhar aqui não pode abortar o import: o pior caso é a prévia daquele arquivo
 * ficar preta, e o resto do app — cortar, ordenar, exportar — não passa pelo
 * `asset://` (o ffmpeg lê o disco direto). Fora do Tauri não há o que liberar.
 */
async function allowMedia(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await invoke("allow_media", { paths });
  } catch {
    /* fora do Tauri (npm run preview) não há escopo pra mexer */
  }
}

/** Extrai a tira de miniaturas de um arquivo (uma vez por arquivo). */
async function loadThumbs(path: string, durationMs: number) {
  if (durationMs <= 0 || useEditor.getState().thumbs[path]) return;
  const timesMs = thumbTimes(0, durationMs, THUMBS_PER_FILE);
  try {
    const files = await invoke<string[]>("thumbs", { id: idForPath(path), path, timesMs });
    useEditor.setState((s) => ({
      thumbs: { ...s.thumbs, [path]: { timesMs, urls: files.map((f) => convertFileSrc(f)) } },
    }));
  } catch {
    // Régua sem miniatura ainda edita. Não vale um toast de erro por isso —
    // o clipe aparece com o nome do arquivo e a vida segue.
  }
}

/** Id estável e curto por caminho (vira nome de pasta no app_data). */
function idForPath(path: string): string {
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h * 33) ^ path.charCodeAt(i)) >>> 0;
  return `m${h.toString(36)}`;
}

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

type Setter = (partial: Partial<EditorState>) => void;
type Getter = () => EditorState;

/** Encurtou o filme? O playhead não pode ficar boiando depois do fim. */
function clampPlayhead(set: Setter, get: Getter) {
  const d = totalDuration(get().history.present);
  if (get().playhead > d) set({ playhead: d });
}

/** Depois de um undo/redo o clipe selecionado pode não existir mais. */
function reconcileSelection(set: Setter, get: Getter) {
  const { selectedId, history } = get();
  if (selectedId && !history.present.clips.some((c) => c.id === selectedId)) {
    set({ selectedId: null });
  }
  clampPlayhead(set, get);
}
