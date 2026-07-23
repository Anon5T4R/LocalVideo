import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";

import { t } from "../lib/i18n";
import { applyMarkers, MarkerParseError, parseMarkers } from "../lib/markers";
import { parseSubtitles, subtitleExtractArgs } from "../lib/subtitles";
import { audioPeaksArgs, expectedSamples, PEAKS_PER_FILE } from "../lib/peaks";
import { isImagePath, thumbTimes, withFps, type MediaInfo, type RawMediaInfo } from "../lib/probe";
import { parseProject, ProjectParseError, serializeProject } from "../lib/project";
import {
  addTitle,
  addTrack,
  appendMedia,
  baseVideoTrack,
  canRedo,
  canUndo,
  DEFAULT_IMAGE_MS,
  isImageClip,
  moveTrack,
  removeTrack,
  setTrackMuted,
  clipCount,
  clipEnd,
  defaultTitle,
  initHistory,
  isMedia,
  locate,
  moveClip,
  insertMediaAt,
  newTimeline,
  pushHistory,
  redo,
  removeClip,
  removeClipRipple,
  duplicateClip,
  splitTargetId,
  detachAudio,
  addSubtitles,
  replacePresent,
  setClipEdge,
  setClipSpeed,
  setTransition,
  setTransitionRipple,
  splitAt,
  timelineDuration,
  undo,
  updateClip,
  type ClipPatch,
  type History,
  type Timeline,
  type TitleProps,
  type TrackKind,
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

/**
 * A chave do mapa de ondas: um arquivo tem uma onda POR FAIXA de áudio.
 *
 * O ordinal é o mesmo espaço de índice do `Clip.audioStreamIndex` (o `a:N` do
 * ffmpeg), não o `AudioTrackInfo.index` do container — ver `audioTrackAt` em
 * `lib/probe.ts` pro histórico de quando a UI misturou os dois. Aqui o erro
 * seria mudo e visual: o clipe do microfone desenharia a onda do áudio do
 * sistema, e nada na tela denunciaria a troca.
 */
export function peakKey(path: string, ordinal: number): string {
  return `${path}#${Math.max(0, Math.round(ordinal))}`;
}

/** Duração padrão de um título novo, em ms. */
const TITLE_DEFAULT_MS = 3000;

/** O interruptor do snap sobrevive à sessão: quem edita no osso não quer
 *  redesligar a cada abertura. `localStorage` (e não o `.tvproj`) porque é jeito
 *  de trabalhar da PESSOA, não propriedade do projeto — o mesmo critério do tema.
 *  O `typeof` é o de sempre: este módulo também é importado por teste em Node. */
const SNAP_KEY = "localvideo.snap";
function loadSnap(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(SNAP_KEY) !== "0"; // ausente = ligado (o padrão)
}

/** Chave do RASCUNHO automático (v0.14). Guarda o último estado da timeline pra
 *  sobreviver a um fechamento sem salvar — a classe de perda de dado mais cara da
 *  casa. Formato = o mesmo `.tvproj`; recuperar é reabrir (ver `restoreDraft`). */
const DRAFT_KEY = "localvideo.draft";
/** Apaga o rascunho: trabalho salvo em arquivo ou descartado (novo projeto) não
 *  precisa mais da rede de segurança. */
function clearDraft(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* sem localStorage: nada a limpar */
  }
}

interface EditorState {
  history: History<Timeline>;
  media: Record<string, MediaInfo>;
  thumbs: Record<string, ThumbStrip>;
  /**
   * A forma de onda de cada FAIXA de áudio já extraída, por `peakKey`. Os
   * valores são 0..1 e cobrem o arquivo inteiro, uniformemente — quem recorta
   * pro trecho do clipe (trim + velocidade + zoom) é o `peakColumns`.
   *
   * Cache de SESSÃO, como as miniaturas: nasce vazio a cada projeto e se enche
   * em segundo plano. Não vai pro `.tvproj` (é derivado do arquivo) nem pro
   * disco — reextrair custa segundos e some com uma classe inteira de bug
   * (cache velho de um arquivo que o usuário regravou por cima).
   */
  peaks: Record<string, number[]>;
  /** Arquivos que o projeto cita mas sumiram do disco. */
  missing: string[];

  selectedId: string | null;
  playhead: number;
  playing: boolean;
  rate: number;
  /** Zoom da régua, em pixels por segundo. */
  pxPerSec: number;

  projectPath: string | null;
  dirty: boolean;
  importing: boolean;
  ffmpegOk: boolean;
  /** Caminho da fonte embarcada (pro compilador de título). Resolvido no `init`. */
  fontPath: string | null;
  /** Há um arrasto (aparar/mover) em curso? (coalesce do undo) */
  editing: boolean;
  /** Esta sessão de arrasto já empilhou o estado de antes? */
  editPushed: boolean;
  /** Modo ripple: aparar PUXA os vizinhos (não deixa buraco). */
  rippleMode: boolean;
  /**
   * O encaixe (snap) está ligado? Até a v0.8 só existia o Alt, que desliga o
   * snap ENQUANTO se segura a tecla — ótimo pra uma exceção, péssimo pra quem
   * está posicionando dez clipes no osso e ficava com a mão presa no teclado.
   * Agora há o interruptor, e o Alt passa a INVERTER o que ele diz (com snap
   * desligado, segurar Alt encaixa) — é o mesmo gesto de exceção nos dois modos.
   */
  snapMode: boolean;

  timeline: () => Timeline;
  duration: () => number;
  canUndo: () => boolean;
  canRedo: () => boolean;

  init: () => Promise<void>;
  /**
   * Importa arquivos. `insert` decide se cada um também vira clipe no fim da
   * trilha base (o fluxo rápido de sempre) ou se só entra no POOL (v0.11).
   *
   * O padrão continua `true` porque é o que o botão Importar e o atalho Ctrl+I
   * prometem desde a v0.1 — quem importa pelo menu quer ver o vídeo na régua, e
   * mudar isso seria tirar um passo de quem só tem um arquivo. Quem SOLTA no
   * painel de mídia passa `false`: ali o gesto diz "guarde pra depois", e o
   * clipe nasce quando o usuário arrastar pra timeline.
   */
  importPaths: (paths: string[], insert?: boolean) => Promise<void>;
  /** Cria um clipe de um arquivo do pool numa trilha/instante (arrasto do painel). */
  doInsertMedia: (path: string, trackId: string, startMs: number) => void;
  /** Tira um arquivo do pool. NÃO mexe na timeline (a UI confirma quando há
   *  clipe usando) nem no disco — some do painel, o arquivo continua lá. */
  doRemoveMedia: (path: string) => void;
  doSplit: () => void;
  /** Apara arrastando uma borda do clipe pra `timelineMs`. */
  doTrimEdge: (id: string, edge: "in" | "out", timelineMs: number) => void;
  /** Move um clipe pra outra trilha e/ou instante. */
  doMoveClip: (id: string, toTrackId: string, startMs: number) => void;
  /** Ajusta a transição (crossfade) entre este clipe e o seguinte. */
  doSetTransition: (id: string, transitionMs: number) => void;
  /** A transição "de um clique" (menu/inspetor): cria/ajusta/remove a
   *  sobreposição puxando o seguinte E a fila atrás — não abre buraco. */
  doSetTransitionRipple: (id: string, transitionMs: number) => void;
  /** Muda propriedades de um clipe (volume, fade, título, opacidade, filtros).
   *  `null` numa chave REMOVE aquela propriedade (zerar um filtro). */
  doUpdateClip: (id: string, patch: ClipPatch) => void;
  /** Muda a velocidade de um clipe (recalcula a posição dos vizinhos). */
  doSetSpeed: (id: string, speed: number) => void;
  /** Cria um título na trilha base, no playhead. */
  doAddTitle: () => void;
  /** Acrescenta uma trilha (vídeo empilha; áudio mixa). */
  doAddTrack: (kind: TrackKind) => void;
  /** Silencia/dessilencia uma trilha inteira (prévia E export). */
  doSetTrackMuted: (trackId: string, muted: boolean) => void;
  /** Remove uma trilha com o que houver nela. A UI confirma quando não é vazia. */
  doRemoveTrack: (trackId: string) => void;
  /** Sobe/desce uma trilha entre as do mesmo tipo. */
  doMoveTrack: (trackId: string, dir: -1 | 1) => void;
  /** Abre uma sessão de arrasto: o arrasto inteiro vira UM passo de undo. */
  beginEdit: () => void;
  endEdit: () => void;
  doRemove: (id?: string) => void;
  /** Duplica o clipe selecionado (ou `id`) logo depois dele (Ctrl+D). */
  doDuplicate: (id?: string) => void;
  /** Separa o áudio do clipe selecionado (ou `id`) numa trilha de áudio. */
  doDetachAudio: (id?: string) => void;
  doUndo: () => void;
  doRedo: () => void;

  select: (id: string | null) => void;
  seek: (ms: number) => void;
  setPlaying: (v: boolean) => void;
  nudgeRate: (dir: -1 | 1) => void;
  setZoom: (pxPerSec: number) => void;
  setRippleMode: (v: boolean) => void;
  setSnapMode: (v: boolean) => void;

  importMarkers: (json: string) => void;
  /** Importa legendas SRT/VTT como clipes de título editáveis. */
  importSubtitles: (raw: string) => void;
  /** Extrai uma legenda EMBUTIDA de um vídeo importado (ordinal `s:N`) e a
   *  importa pelo mesmo caminho do arquivo externo. */
  importEmbeddedSubtitles: (path: string, ordinal: number) => Promise<void>;

  newProject: () => void;
  openProject: (path: string) => Promise<void>;
  saveProject: (path: string) => Promise<void>;
  /** Grava o RASCUNHO (timeline+pool) no localStorage. Chamado com debounce+teto
   *  pelo App — a rede de segurança pra quem fecha o app sem salvar em arquivo. */
  writeDraft: () => void;
  /** Recupera o rascunho ao abrir o app (quando não há projeto na tela). Volta
   *  como projeto NÃO salvo (dirty), sem caminho — é trabalho, não arquivo. */
  restoreDraft: () => Promise<boolean>;
}

/** Um arquivo que não entrou, já traduzido: `name` é o NOME (nunca o caminho
 *  absoluto — ele come a tela e não diz nada que o nome não diga). */
export interface ImportFailure {
  name: string;
  why: string;
}

/** Quantos nomes cabem num toast antes de virar parágrafo. */
const MAX_NAMES = 3;

/**
 * Monta a frase do que não entrou. Pura e exportada porque é ELA que o teste de
 * regressão do arquivo inválido prende — o toast é só o mensageiro.
 */
export function importFailureMessage(failures: ImportFailure[]): string | null {
  if (failures.length === 0) return null;
  const uniq = [...new Map(failures.map((f) => [`${f.name} ${f.why}`, f])).values()];
  if (uniq.length === 1) return `${uniq[0].name} — ${uniq[0].why}`;

  const names = uniq.map((f) => f.name);
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const rest = names.length - MAX_NAMES;
  return t("err.batchFailed", {
    n: names.length,
    names: rest > 0 ? t("err.andMore", { names: shown, n: rest }) : shown,
  });
}

function reportImportFailures(failures: ImportFailure[]) {
  const msg = importFailureMessage(failures);
  if (msg) useUi.getState().pushToast("error", msg);
}

/** Um erro do Rust vira frase de gente, no idioma da UI. */
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
  history: initHistory<Timeline>(newTimeline()),
  media: {},
  thumbs: {},
  peaks: {},
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
  fontPath: null,
  editing: false,
  editPushed: false,
  rippleMode: false,
  snapMode: loadSnap(),

  timeline: () => get().history.present,
  duration: () => timelineDuration(get().history.present),
  canUndo: () => canUndo(get().history),
  canRedo: () => canRedo(get().history),

  init: async () => {
    try {
      set({ ffmpegOk: await invoke<boolean>("ffmpeg_ok") });
    } catch {
      // Fora do Tauri (npm run preview) não há runtime pra checar.
      set({ ffmpegOk: false });
    }
    try {
      set({ fontPath: await invoke<string | null>("font_path") });
    } catch {
      set({ fontPath: null });
    }
  },

  importPaths: async (paths, insert = true) => {
    if (paths.length === 0) return;
    set({ importing: true });
    try {
      await allowMedia(paths);
      const failures: ImportFailure[] = [];
      for (const path of paths) {
        let info: MediaInfo;
        try {
          info = withFps(await invoke<RawMediaInfo>("probe", { path }));
        } catch (e) {
          failures.push({ name: baseName(path), why: humanError(e) });
          continue;
        }

        set((s) => {
          // O pool recebe SEMPRE — inserir ou não é sobre a timeline, não sobre
          // conhecer o arquivo. (E `media` é o pool desde a v0.11: ver o
          // `serializeProject`.)
          const media = { ...s.media, [path]: info };
          if (!insert) {
            // Só o pool: nada de clipe, nada de undo (o histórico é da TIMELINE
            // — empilhar um passo que não mudou nenhuma trilha faria um Ctrl+Z
            // "não fazer nada" na cara do usuário). Mas SUJA o projeto: o pool
            // vai pro arquivo, então há o que salvar.
            return { media, dirty: true };
          }
          // O clipe entra INTEIRO (0..duração) no fim da trilha base. Imagem não
          // tem duração de arquivo (o probe diz 0): entra com a duração padrão de
          // slide e a flag `image` (o export usa `-loop 1 -t`).
          const isImg = isImagePath(path);
          const tl = appendMedia(s.history.present, {
            path,
            srcIn: 0,
            srcOut: isImg ? DEFAULT_IMAGE_MS : info.durationMs,
            image: isImg,
          });
          const base = baseVideoTrack(tl);
          const last = base?.clips[base.clips.length - 1];
          return {
            media,
            history: pushHistory(s.history, tl),
            dirty: true,
            selectedId: last?.id ?? s.selectedId,
          };
        });

        void loadThumbs(path, info.durationMs);
        void loadPeaks(path, info);
      }
      reportImportFailures(failures);
    } finally {
      set({ importing: false });
    }
  },

  doInsertMedia: (path, trackId, startMs) => {
    const { history, media } = get();
    const info = media[path];
    if (!info) return; // não está no pool: não há duração pra dar ao clipe
    const before = new Set<string>();
    for (const tk of history.present.tracks) for (const c of tk.clips) before.add(c.id);
    const isImg = isImagePath(path);
    const next = insertMediaAt(history.present, trackId, startMs, {
      path,
      srcIn: 0,
      // Imagem: sem duração de arquivo (probe = 0), entra com o padrão de slide.
      srcOut: isImg ? DEFAULT_IMAGE_MS : info.durationMs,
      image: isImg,
    });
    if (next === history.present) return;
    // O clipe recém-nascido vira a seleção — mesma regra do Ctrl+D e do título:
    // quem acabou de soltar um clipe quer mexer NELE, e o inspetor já abre com
    // as propriedades certas.
    let createdId: string | null = null;
    for (const tk of next.tracks) for (const c of tk.clips) if (!before.has(c.id)) createdId = c.id;
    set({ history: pushHistory(history, next), dirty: true, selectedId: createdId });
  },

  doRemoveMedia: (path) => {
    const { media } = get();
    if (!media[path]) return;
    // Sai do pool E dos caches derivados dele: deixar a tira de miniaturas e a
    // onda para trás seria vazamento silencioso (e, se o mesmo caminho voltasse
    // com outro conteúdo — o usuário regravou por cima —, o app desenharia a
    // miniatura ANTIGA do arquivo novo, que é bug invisível).
    set((s) => {
      const nextMedia = { ...s.media };
      delete nextMedia[path];
      const thumbs = { ...s.thumbs };
      delete thumbs[path];
      const peaks: Record<string, number[]> = {};
      for (const [k, v] of Object.entries(s.peaks)) {
        if (!k.startsWith(`${path}#`)) peaks[k] = v;
      }
      return {
        media: nextMedia,
        thumbs,
        peaks,
        missing: s.missing.filter((p) => p !== path),
        dirty: true,
      };
    });
  },

  doSplit: () => {
    const { history, playhead, selectedId } = get();
    const id = splitTargetId(history.present, selectedId, playhead);
    if (!id) return;
    const next = splitAt(history.present, id, playhead);
    if (next === history.present) return;
    set({ history: pushHistory(history, next), dirty: true });
  },

  doTrimEdge: (id, edge, timelineMs) => {
    const { history, media, editing, editPushed, rippleMode } = get();
    const loc = locate(history.present, id);
    if (!loc) return;
    // Limite = duração do ARQUIVO (mídia): aparar não inventa vídeo que não há.
    // Imagem NÃO tem limite (uma imagem dura o que o usuário quiser): sem isso o
    // `srcLimit` viria do probe (0) e a imagem não esticaria de jeito nenhum.
    const limit =
      loc.clip.path && !isImageClip(loc.clip) ? media[loc.clip.path]?.durationMs : undefined;
    const next = setClipEdge(history.present, id, edge, timelineMs, limit, rippleMode);
    if (next === history.present) return;
    const first = !editing || !editPushed;
    set({
      history: first ? pushHistory(history, next) : replacePresent(history, next),
      dirty: true,
      editPushed: true,
    });
    clampPlayhead(set, get);
  },

  doMoveClip: (id, toTrackId, startMs) => {
    const { history, editing, editPushed } = get();
    const next = moveClip(history.present, id, toTrackId, startMs);
    if (next === history.present) return;
    const first = !editing || !editPushed;
    set({
      history: first ? pushHistory(history, next) : replacePresent(history, next),
      dirty: true,
      editPushed: true,
    });
  },

  doSetTransition: (id, transitionMs) => {
    const { history, editing, editPushed } = get();
    const next = setTransition(history.present, id, transitionMs);
    if (next === history.present) return;
    const first = !editing || !editPushed;
    set({
      history: first ? pushHistory(history, next) : replacePresent(history, next),
      dirty: true,
      editPushed: true,
    });
  },

  doSetTransitionRipple: (id, transitionMs) => {
    const { history } = get();
    const next = setTransitionRipple(history.present, id, transitionMs);
    if (next === history.present) return;
    // Ação discreta (clique de menu/campo), não arrasto: cada mexida é um passo
    // de undo próprio — igual ao doSetSpeed.
    set({ history: pushHistory(history, next), dirty: true });
    clampPlayhead(set, get);
  },

  doUpdateClip: (id, patch) => {
    const { history, editing, editPushed } = get();
    const next = updateClip(history.present, id, patch);
    if (next === history.present) return;
    // Fora de uma sessão de arrasto (`editing` falso), cada mexida do inspetor é
    // seu próprio passo de undo — igual à v0.3. DENTRO de um arrasto (as alças de
    // PiP na prévia chamam `beginEdit`), o arrasto inteiro coalesce em UM passo:
    // empilha no 1º movimento e daí só troca o presente. É a MESMA regra do
    // aparar/mover — sem ela, um arrasto de PiP viraria dezenas de Ctrl+Z.
    const first = !editing || !editPushed;
    set({
      history: first ? pushHistory(history, next) : replacePresent(history, next),
      dirty: true,
      editPushed: true,
    });
  },

  doSetSpeed: (id, speed) => {
    const { history } = get();
    const next = setClipSpeed(history.present, id, speed);
    if (next === history.present) return;
    set({ history: pushHistory(history, next), dirty: true });
    clampPlayhead(set, get);
  },

  doAddTitle: () => {
    const { history, playhead } = get();
    const base = baseVideoTrack(history.present);
    if (!base) return;
    const before = new Set<string>();
    for (const tk of history.present.tracks) for (const c of tk.clips) before.add(c.id);
    const props: TitleProps = defaultTitle(t("title.defaultText"));
    const next = addTitle(history.present, base.id, playhead, TITLE_DEFAULT_MS, props);
    if (next === history.present) return;
    // O título novo é o único id que não existia antes.
    let createdId: string | null = null;
    for (const tk of next.tracks) for (const c of tk.clips) if (!before.has(c.id)) createdId = c.id;
    set({ history: pushHistory(history, next), dirty: true, selectedId: createdId });
  },

  doAddTrack: (kind) => {
    const { history } = get();
    set({ history: pushHistory(history, addTrack(history.present, kind)), dirty: true });
  },

  doSetTrackMuted: (trackId, muted) => {
    const { history } = get();
    const next = setTrackMuted(history.present, trackId, muted);
    if (next === history.present) return;
    set({ history: pushHistory(history, next), dirty: true });
  },

  doRemoveTrack: (trackId) => {
    const { history, selectedId } = get();
    const gone = history.present.tracks.find((t) => t.id === trackId);
    const next = removeTrack(history.present, trackId);
    if (next === history.present) return;
    // O clipe selecionado pode ter ido junto com a trilha — soltar a seleção aqui
    // evita um inspetor mostrando propriedades de um clipe que não existe mais.
    const lost = !!gone?.clips.some((c) => c.id === selectedId);
    set({ history: pushHistory(history, next), dirty: true, ...(lost ? { selectedId: null } : {}) });
    clampPlayhead(set, get);
  },

  doMoveTrack: (trackId, dir) => {
    const { history } = get();
    const next = moveTrack(history.present, trackId, dir);
    if (next === history.present) return;
    set({ history: pushHistory(history, next), dirty: true });
  },

  beginEdit: () => set({ editing: true, editPushed: false }),
  endEdit: () => set({ editing: false, editPushed: false }),

  doRemove: (id) => {
    const target = id ?? get().selectedId;
    if (!target) return;
    const { history, rippleMode } = get();
    // O modo Ripple vale pro Del também (v0.7.1): antes ele só mandava no
    // aparar, então o mesmo interruptor "não deixa buraco" deixava um buraco
    // enorme quando se apagava um clipe. Ver `removeClipRipple`.
    const next = rippleMode
      ? removeClipRipple(history.present, target)
      : removeClip(history.present, target);
    if (next === history.present) return;
    set({
      history: pushHistory(history, next),
      dirty: true,
      selectedId: get().selectedId === target ? null : get().selectedId,
    });
    clampPlayhead(set, get);
  },

  doDuplicate: (id) => {
    const target = id ?? get().selectedId;
    if (!target) return;
    const { history } = get();
    const before = new Set<string>();
    for (const tk of history.present.tracks) for (const c of tk.clips) before.add(c.id);
    const next = duplicateClip(history.present, target);
    if (next === history.present) return;
    // A CÓPIA vira a seleção (é o que o dedo espera de um Ctrl+D: continuar
    // mexendo no que acabou de nascer, não no original).
    let createdId: string | null = null;
    for (const tk of next.tracks) for (const c of tk.clips) if (!before.has(c.id)) createdId = c.id;
    set({ history: pushHistory(history, next), dirty: true, selectedId: createdId ?? target });
  },

  doDetachAudio: (id) => {
    const target = id ?? get().selectedId;
    if (!target) return;
    const { history, media } = get();
    const loc = locate(history.present, target);
    // Quantas faixas de áudio o arquivo-fonte tem — vem do probe guardado na
    // importação. Sem a info (não deveria acontecer), trata como uma faixa.
    const count = loc?.clip.path ? (media[loc.clip.path]?.audioTracks.length ?? 1) : 1;
    const next = detachAudio(history.present, target, Math.max(1, count));
    if (next === history.present) return;
    set({ history: pushHistory(history, next), dirty: true });
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
    set({ playhead: Math.max(0, Math.min(Math.round(ms), timelineDuration(get().history.present))) }),
  setPlaying: (playing) => set({ playing, rate: playing ? get().rate : 1 }),

  nudgeRate: (dir) => {
    const { playing, rate } = get();
    if (!playing) {
      set({ playing: true, rate: dir });
      return;
    }
    if (Math.sign(rate) === dir) {
      set({ rate: Math.sign(rate) * Math.min(8, Math.abs(rate) * 2) });
      return;
    }
    set({ rate: dir });
  },

  setZoom: (pxPerSec) => set({ pxPerSec: Math.max(4, Math.min(400, pxPerSec)) }),
  setRippleMode: (rippleMode) => set({ rippleMode }),
  setSnapMode: (snapMode) => {
    try {
      localStorage.setItem(SNAP_KEY, snapMode ? "1" : "0");
    } catch {
      /* sem localStorage (teste em Node) o interruptor ainda vale na sessão */
    }
    set({ snapMode });
  },

  /**
   * Ponte com o LocalRecord: marcadores viram cortes. (Estado real da ponte no
   * cabeçalho de `lib/markers.ts` — o Record ainda não os exporta.)
   */
  importSubtitles: (raw) => {
    const cues = parseSubtitles(raw);
    if (cues.length === 0) {
      useUi.getState().pushToast("error", t("sub.empty"));
      return;
    }
    const { history } = get();
    const next = addSubtitles(history.present, cues);
    set({ history: pushHistory(history, next), dirty: true });
    useUi.getState().pushToast("info", t("sub.imported", { n: String(cues.length) }));
  },

  importEmbeddedSubtitles: async (path, ordinal) => {
    let raw: string;
    try {
      // O ffmpeg converte a faixa (mov_text/subrip) pra SRT no stdout; daqui em
      // diante o caminho é O MESMO do arquivo externo (parseSubtitles → clipes).
      raw = await invoke<string>("extract_text", { args: subtitleExtractArgs(path, ordinal) });
    } catch {
      useUi.getState().pushToast("error", t("sub.extractFailed"));
      return;
    }
    get().importSubtitles(raw);
  },

  importMarkers: (json) => {
    let file: ReturnType<typeof parseMarkers>;
    try {
      file = parseMarkers(json);
    } catch (e) {
      useUi
        .getState()
        .pushToast(
          "error",
          e instanceof MarkerParseError && e.message === "empty" ? t("mk.empty") : t("mk.corrupt"),
        );
      return;
    }

    const tl = get().history.present;
    const base = baseVideoTrack(tl);
    const paths = [...new Set((base?.clips ?? []).filter(isMedia).map((c) => c.path!))];

    const source = file.source ?? (paths.length === 1 ? paths[0] : null);
    if (!source) {
      useUi.getState().pushToast("error", t("mk.whichSource"));
      return;
    }
    if (!paths.includes(source)) {
      useUi.getState().pushToast("error", t("mk.sourceNotHere", { name: baseName(source) }));
      return;
    }

    const r = applyMarkers(tl, source, file.markers);
    if (r.applied === 0) {
      useUi.getState().pushToast("info", t("mk.noneApplied"));
      return;
    }
    set({ history: pushHistory(get().history, r.timeline), dirty: true });
    useUi
      .getState()
      .pushToast(
        "ok",
        r.skipped > 0
          ? t("mk.appliedSome", { n: r.applied, skipped: r.skipped })
          : t("mk.applied", { n: r.applied }),
      );
  },

  newProject: () => {
    clearDraft(); // "começar do zero" descarta a rede de segurança de propósito
    set({
      history: initHistory<Timeline>(newTimeline()),
      media: {},
      thumbs: {},
      peaks: {},
      missing: [],
      selectedId: null,
      playhead: 0,
      playing: false,
      rate: 1,
      projectPath: null,
      dirty: false,
    });
  },

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
      useUi.getState().pushToast("error", parseErrorMessage(e));
      return;
    }
    await applyProjectDoc(doc, path);
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
      clearDraft(); // o trabalho está seguro no arquivo agora
      useUi.getState().pushToast("ok", t("proj.saved", { name: baseName(path) }));
    } catch {
      useUi.getState().pushToast("error", t("proj.saveFailed"));
    }
  },

  writeDraft: () => {
    if (typeof localStorage === "undefined") return;
    const { history, media } = get();
    const raws: Record<string, RawMediaInfo> = {};
    for (const [p, info] of Object.entries(media)) {
      const { fps: _fps, ...raw } = info;
      raws[p] = raw;
    }
    try {
      // O MESMO formato do `.tvproj` (serializeProject) — assim o rascunho é só
      // um projeto guardado noutro lugar, e recuperar é reabrir. Se o
      // localStorage estourar a cota (projeto gigante), engolimos: o rascunho é
      // rede de segurança, não pode derrubar a edição por não caber.
      localStorage.setItem(DRAFT_KEY, serializeProject(history.present, raws));
    } catch {
      /* cota cheia ou modo privado: sem rascunho, a edição segue */
    }
  },

  restoreDraft: async () => {
    if (typeof localStorage === "undefined") return false;
    const json = localStorage.getItem(DRAFT_KEY);
    if (!json) return false;
    let doc: ReturnType<typeof parseProject>;
    try {
      doc = parseProject(json);
    } catch {
      // Rascunho corrompido não vale um erro na cara de quem só abriu o app —
      // descarta em silêncio e começa limpo.
      localStorage.removeItem(DRAFT_KEY);
      return false;
    }
    // Volta como trabalho NÃO salvo: sem caminho de arquivo e `dirty`, porque é
    // exatamente o que era quando o app fechou. Salvar em `.tvproj` é decisão de
    // quem recuperou.
    await applyProjectDoc(doc, null);
    set({ dirty: true });
    return true;
  },
}));

/** Traduz um `ProjectParseError` pro texto do usuário (idioma da UI). */
function parseErrorMessage(e: unknown): string {
  if (e instanceof ProjectParseError && e.message === "newer") return t("proj.newer");
  if (e instanceof ProjectParseError && e.message === "notOurs") return t("proj.notOurs");
  return t("proj.corrupt");
}

/**
 * Aplica um projeto já parseado ao estado — o corpo comum de `openProject` (de
 * arquivo) e `restoreDraft` (do localStorage). `path` é o caminho do `.tvproj`,
 * ou `null` quando é rascunho (projeto sem arquivo ainda).
 *
 * O .tvproj guarda CAMINHO, não vídeo: confere existência, põe no escopo de
 * asset e recarrega miniaturas/ondas. A lista sai do POOL e não só dos clipes
 * (v0.11) — um arquivo importado ainda sem clipe também precisa do cheque.
 */
async function applyProjectDoc(doc: ReturnType<typeof parseProject>, path: string | null): Promise<void> {
  const paths = [
    ...new Set([
      ...Object.keys(doc.media),
      ...doc.timeline.tracks.flatMap((tk) => tk.clips.filter(isMedia).map((c) => c.path!)),
    ]),
  ];
  let missing: string[] = [];
  try {
    const exists = await invoke<boolean[]>("paths_exist", { paths });
    missing = paths.filter((_, i) => !exists[i]);
  } catch {
    /* fora do Tauri: sem o que conferir */
  }

  await allowMedia(paths.filter((p) => !missing.includes(p)));

  const media: Record<string, MediaInfo> = {};
  for (const [p, raw] of Object.entries(doc.media)) media[p] = withFps(raw);

  useEditor.setState({
    history: initHistory(doc.timeline),
    media,
    thumbs: {},
    peaks: {},
    missing,
    selectedId: null,
    playhead: 0,
    playing: false,
    projectPath: path,
    dirty: false,
  });

  for (const p of paths) {
    if (missing.includes(p)) continue;
    const info = media[p];
    if (!info) continue; // clipe sem entrada no pool (projeto ≤0.10 podado)
    void loadThumbs(p, info.durationMs);
    void loadPeaks(p, info);
  }
  if (missing.length > 0) {
    useUi.getState().pushToast("error", t("proj.missingMedia", { n: missing.length }));
  }
}

/**
 * Põe estes arquivos no escopo do protocolo de asset (ver `media::allow_media`).
 * Falhar aqui não aborta o import: o pior caso é a prévia daquele arquivo ficar
 * preta. Fora do Tauri não há o que liberar.
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
    // Régua sem miniatura ainda edita — não vale um toast por isso.
  }
}

/**
 * Extrações de onda em VOO — sem isto, abrir um projeto que usa o mesmo arquivo
 * em cinco clipes dispararia cinco ffmpeg iguais em paralelo (o cheque no
 * `peaks[key]` não pega nada enquanto a primeira ainda não voltou). É o mesmo
 * cuidado que o `loadThumbs` consegue de graça por ser um por arquivo.
 */
const peaksInFlight = new Set<string>();

/**
 * Extrai a forma de onda de TODAS as faixas de áudio de um arquivo, em segundo
 * plano — o mesmo padrão das miniaturas, e pelo mesmo motivo: **o import não
 * pode ficar mais lento**. Quem chama faz `void loadPeaks(...)` e segue; o clipe
 * já está na régua e a onda chega quando chegar.
 *
 * Todas as faixas, e não só a 0, porque o gesto que revela a onda é "separar
 * áudio" num take do LocalRecord (microfone + áudio do sistema): extrair só a
 * primeira deixaria o segundo clipe vazio justo no caso que motivou a fatia.
 * Uma faixa que ninguém destacar custou um ffmpeg de segundo plano — barato
 * perto de a onda aparecer só depois do clique.
 */
async function loadPeaks(path: string, info: MediaInfo) {
  if (info.durationMs <= 0) return;
  for (let ordinal = 0; ordinal < info.audioTracks.length; ordinal++) {
    const key = peakKey(path, ordinal);
    if (useEditor.getState().peaks[key] || peaksInFlight.has(key)) continue;
    peaksInFlight.add(key);
    try {
      // O Rust devolve 0..255 (byte por balde, JSON 4× menor); a UI pensa em
      // 0..1, então a conversão morre aqui e não em cada render da régua.
      const raw = await invoke<number[]>("audio_peaks", {
        args: audioPeaksArgs(path, ordinal),
        buckets: PEAKS_PER_FILE,
        expectedSamples: expectedSamples(info.durationMs),
      });
      const peaks = raw.map((v) => v / 255);
      useEditor.setState((s) => ({ peaks: { ...s.peaks, [key]: peaks } }));
    } catch {
      // Régua sem onda ainda edita — não vale um toast por isso (idem thumbs).
    } finally {
      peaksInFlight.delete(key);
    }
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

/**
 * A PASTA que contém o arquivo — o alvo do "mostrar na pasta" quando o reveal
 * nativo (que seleciona o arquivo) não está disponível e a gente cai pra só
 * abrir a pasta. Puro e testado porque é o caminho que vai CRU pro SO: errar o
 * separador (ou comer o último `\`) abriria a pasta errada, ou nenhuma.
 *
 * Não "escapa" nada: `openPath`/`revealItemInDir` recebem o caminho literal (o
 * plugin não passa por shell), então um caminho com espaço/acento/`&` vai
 * inteiro. O cuidado aqui é achar o corte certo, não citar a string.
 */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // Sem separador: é um nome solto, a "pasta" é o diretório atual (".").
  if (i < 0) return ".";
  // Raiz do Windows (`C:\arq`) ou do POSIX (`/arq`): mantém a barra pra não
  // devolver `C:` (que o SO lê como "diretório atual da unidade C", não a raiz).
  if (i === 0) return path.slice(0, 1);
  if (path[i] === "\\" && path[i - 1] === ":") return path.slice(0, i + 1);
  return path.slice(0, i);
}

type Setter = (partial: Partial<EditorState>) => void;
type Getter = () => EditorState;

/** Encurtou o filme? O playhead não pode ficar boiando depois do fim. */
function clampPlayhead(set: Setter, get: Getter) {
  const d = timelineDuration(get().history.present);
  if (get().playhead > d) set({ playhead: d });
}

/** Depois de um undo/redo (ou remoção) o clipe selecionado pode não existir. */
function reconcileSelection(set: Setter, get: Getter) {
  const { selectedId, history } = get();
  if (selectedId && !locate(history.present, selectedId)) {
    set({ selectedId: null });
  }
  clampPlayhead(set, get);
}

// Reexporta pro resto do app o que era exposto pela store antiga.
export { clipCount, clipEnd };
