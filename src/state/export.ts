import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  concatArgs,
  concatListBody,
  encodeArgs,
  keyframeProbeArgs,
  parseKeyframesCsv,
  planExport,
  type ExportClip,
  type ExportPlan,
  type SourceInfo,
} from "../lib/args";
import { t } from "../lib/i18n";
import { newId, totalDuration } from "../lib/timeline";
import { baseName, useEditor } from "./editor";
import { useUi } from "./ui";

/**
 * O export: sondar quadros-chave → planejar → rodar o ffmpeg → contar o que
 * aconteceu.
 *
 * Store à parte do `editor` de propósito: exportar não é editar. Nada aqui mexe
 * na timeline nem entra no undo — é uma leitura do projeto que vira arquivo. E
 * assim o modal de export pode ir e voltar sem arrastar o estado do editor.
 *
 * Toda a matemática (qual caminho, quais args) mora em `lib/args.ts`, pura e
 * testada. Aqui é só orquestração: chamar na ordem certa, ouvir o progresso, e
 * limpar a sujeira.
 */

/** Uma etapa do trabalho. O caminho copy tem duas; o encode tem uma. */
type Phase = "idle" | "probing" | "ready" | "cutting" | "joining" | "encoding" | "done";

export interface ExportProgress {
  /** Fração 0..1 do filme já escrito. */
  frac: number;
  /** Segundos que faltam, na conta do próprio ritmo do job. `null` = cedo demais. */
  etaSec: number | null;
  /** "2.31x" — o quanto o ffmpeg corre em relação ao tempo real. */
  speed: string;
}

interface ExportState {
  open: boolean;
  phase: Phase;
  /** Quadros-chave por caminho de arquivo (cache da sessão). */
  keyframes: Record<string, number[]>;
  plan: ExportPlan | null;
  /** Encostar cortes no quadro-chave vizinho pra ganhar o `-c copy`. */
  snap: boolean;
  /** O plano SE o usuário ligasse o encosto — pra UI saber se vale oferecer. */
  snapWouldHelp: boolean;
  outPath: string | null;
  progress: ExportProgress;
  /** Resultado do último export bem-sucedido (a UI conta o que aconteceu). */
  result: { path: string; plan: ExportPlan; elapsedMs: number } | null;

  openDialog: () => Promise<void>;
  close: () => void;
  setSnap: (v: boolean) => void;
  setOutPath: (p: string) => void;
  run: () => Promise<void>;
  cancel: () => void;
}

/** Id do job em curso. Fora do store: muda a cada etapa e a UI não precisa
 *  redesenhar por causa disso. */
let currentJob: string | null = null;
let canceling = false;

const ZERO: ExportProgress = { frac: 0, etaSec: null, speed: "" };

export const useExport = create<ExportState>((set, get) => ({
  open: false,
  phase: "idle",
  keyframes: {},
  plan: null,
  snap: false,
  snapWouldHelp: false,
  outPath: null,
  progress: ZERO,
  result: null,

  openDialog: async () => {
    const ed = useEditor.getState();
    const clips = ed.history.present.clips;
    if (clips.length === 0) return;

    set({ open: true, phase: "probing", plan: null, result: null, progress: ZERO });

    // Sonda de quadros-chave: um ffprobe por ARQUIVO (não por clipe — dez cortes
    // do mesmo vídeo têm os mesmos quadros-chave). O cache é da sessão inteira.
    const paths = [...new Set(clips.map((c) => c.path))];
    const kf: Record<string, number[]> = { ...get().keyframes };
    for (const p of paths) {
      if (kf[p]) continue;
      try {
        const csv = await invoke<string>("probe_keyframes", { args: keyframeProbeArgs(p) });
        kf[p] = parseKeyframesCsv(csv);
      } catch {
        // Sem a lista, o `planExport` já sabe o que fazer: recodifica em vez de
        // chutar. Não vale um toast de erro — o export vai funcionar.
        kf[p] = [];
      }
    }

    // O usuário pode ter fechado o modal enquanto o ffprobe rodava.
    if (!get().open) return;

    const sources = buildSources(kf);
    const plan = planExport(clips, sources, { snap: get().snap });
    // Vale oferecer o encosto? Só se ele REALMENTE mudar o caminho — checkbox
    // que não faz nada é pior que checkbox nenhum.
    const snapped = planExport(clips, sources, { snap: true });
    set({
      keyframes: kf,
      plan,
      snapWouldHelp: plan.kind === "encode" && snapped.kind === "copy",
      phase: "ready",
      outPath: get().outPath ?? (await defaultOut(clips)),
    });
  },

  close: () => {
    // Fechar no meio do trabalho não pode deixar ffmpeg rodando escondido.
    if (isRunning(get().phase)) get().cancel();
    set({ open: false, phase: "idle", progress: ZERO });
  },

  setSnap: (snap) => {
    set({ snap });
    const ed = useEditor.getState();
    const sources = buildSources(get().keyframes);
    set({ plan: planExport(ed.history.present.clips, sources, { snap }) });
  },

  setOutPath: (outPath) => set({ outPath }),

  cancel: () => {
    canceling = true;
    if (currentJob) void invoke("ff_cancel", { jobId: currentJob });
  },

  run: async () => {
    const { plan, outPath } = get();
    if (!plan || !outPath || isRunning(get().phase)) return;

    canceling = false;
    const started = Date.now();
    const totalMs = plan.clips.reduce((s, c) => s + (c.srcOut - c.srcIn), 0);
    // Nunca sobrescrever calado o vídeo de alguém.
    const finalOut = await invoke<string>("unique_path", { path: outPath });
    const tmps: string[] = [];

    try {
      if (plan.kind === "copy") {
        await runCopy(plan, finalOut, totalMs, tmps, set);
      } else {
        await runEncode(plan, finalOut, totalMs, set);
      }

      set({
        phase: "done",
        result: { path: finalOut, plan, elapsedMs: Date.now() - started },
        progress: { frac: 1, etaSec: 0, speed: "" },
      });
    } catch (e) {
      set({ phase: "ready", progress: ZERO });
      const code = String(e);
      if (code === "canceled" || canceling) {
        useUi.getState().pushToast("info", t("exp.canceled"));
        // Cancelou = não existe meio-vídeo por aí. Um arquivo truncado com nome
        // de filme pronto é pior que arquivo nenhum.
        void invoke("cleanup_tmp", { paths: [finalOut] });
      } else {
        useUi
          .getState()
          .pushToast("error", code === "no-runtime" ? t("err.noRuntime") : t("exp.failed"));
      }
    } finally {
      currentJob = null;
      if (tmps.length > 0) void invoke("cleanup_tmp", { paths: tmps });
    }
  },
}));

function isRunning(p: Phase): boolean {
  return p === "cutting" || p === "joining" || p === "encoding";
}

type Set = (partial: Partial<ExportState>) => void;

/**
 * Caminho `-c copy`: o concat demuxer corta e cola numa passada só.
 *
 * Os cortes vão como `inpoint`/`outpoint` na lista (ver `concatListBody`), então
 * não há trecho temporário nenhum: o vídeo é escrito UMA vez, direto no destino.
 */
async function runCopy(
  plan: ExportPlan,
  out: string,
  totalMs: number,
  tmps: string[],
  set: Set,
): Promise<void> {
  set({ phase: "joining" });
  const list = await invoke<string>("write_tmp_text", {
    name: `${newId("x")}.txt`,
    body: concatListBody(plan.clips),
  });
  tmps.push(list);
  await runJob(concatArgs(list, out, hasAudioEverywhere(plan.clips)), totalMs, 0, 1, set);
}

/** Caminho `filter_complex`: um job só, do começo ao fim. */
async function runEncode(plan: ExportPlan, out: string, totalMs: number, set: Set): Promise<void> {
  set({ phase: "encoding" });
  const sources = buildSources(useExport.getState().keyframes);
  await runJob(encodeArgs(plan.clips, sources, out, {}), totalMs, 0, 1, set);
}

/**
 * Roda UM ffmpeg e vai empurrando o progresso.
 *
 * `base`/`span` mapeiam este job num pedaço da barra: recortar ocupa 0..0,5 e
 * colar 0,5..1. Sem isso a barra encheria, voltaria pro zero e encheria de novo
 * — e o usuário concluiria, com razão, que o app se perdeu.
 */
async function runJob(
  args: string[],
  totalMs: number,
  base: number,
  span: number,
  set: Set,
): Promise<void> {
  const jobId = newId("job");
  currentJob = jobId;
  const started = Date.now();

  let un: UnlistenFn | undefined;
  try {
    un = await listen<{ jobId: string; outTimeMs: number; speed: string }>(
      "ffjob-progress",
      (e) => {
        if (e.payload.jobId !== jobId) return;
        // `outTimeMs` já chega em ms: a conversão do µs do ffmpeg morreu no Rust.
        const local = totalMs > 0 ? Math.min(1, e.payload.outTimeMs / totalMs) : 0;
        const frac = Math.min(1, base + local * span);
        const elapsed = (Date.now() - started) / 1000;
        // ETA pelo ritmo REAL deste job, não pelo "speed" do ffmpeg: o speed
        // oscila a cada quadro e faria o número pular na tela.
        const etaSec = local > 0.02 ? Math.max(0, elapsed / local - elapsed) : null;
        set({ progress: { frac, etaSec, speed: e.payload.speed } });
      },
    );
    await invoke("ff_run", { jobId, args });
  } finally {
    un?.();
  }
}

/** Junta o que a sonda (`editor.media`) e a sonda de quadros-chave sabem. */
function buildSources(keyframes: Record<string, number[]>): Record<string, SourceInfo> {
  const media = useEditor.getState().media;
  const out: Record<string, SourceInfo> = {};
  for (const [path, m] of Object.entries(media)) {
    out[path] = {
      keyframesMs: keyframes[path] ?? [],
      width: m.width,
      height: m.height,
      fps: m.fps,
      hasAudio: m.hasAudio,
      videoCodec: m.videoCodec,
      audioCodec: m.audioCodec,
    };
  }
  return out;
}

/** No `-c copy` ou todo mundo tem áudio, ou ninguém: o concat demuxer não
 *  inventa trilha, e o `planExport` já barrou a mistura antes de chegar aqui. */
function hasAudioEverywhere(clips: ExportClip[]): boolean {
  const media = useEditor.getState().media;
  return clips.every((c) => media[c.path]?.hasAudio);
}

/** Sugestão de destino: ao lado do primeiro vídeo, com nome que se entende. */
async function defaultOut(clips: ExportClip[]): Promise<string> {
  const first = clips[0].path;
  const sep = first.includes("\\") ? "\\" : "/";
  const dir = first.slice(0, Math.max(first.lastIndexOf("\\"), first.lastIndexOf("/")));
  const stem = baseName(first).replace(/\.[^.]+$/, "");
  return `${dir}${sep}${stem} - montagem.mp4`;
}

/** Duração total do filme montado — a UI mostra ao lado do plano. */
export function plannedDuration(): number {
  return totalDuration(useEditor.getState().history.present);
}
