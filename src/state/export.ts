import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  concatArgs,
  concatListBody,
  degenerateClips,
  encodeArgs,
  filterComplexArgs,
  keyframeProbeArgs,
  parseKeyframesCsv,
  planExport,
  type ExportClip,
  type ExportPlan,
  type SourceInfo,
} from "../lib/args";
import { t } from "../lib/i18n";
import { newId, timelineDuration } from "../lib/timeline";
import { baseName, useEditor } from "./editor";
import { useUi } from "./ui";

/**
 * O export: decidir o CAMINHO → (sondar quadros-chave, se for o caso) → rodar o
 * ffmpeg → contar o que aconteceu.
 *
 * ─── Os TRÊS caminhos da v0.2 ────────────────────────────────────────────────
 *
 * 1. **`-c copy` (concat demuxer)** — timeline DEGENERADA (1 trilha, em fila, sem
 *    transição/título/fade/volume): corta e cola movendo pacotes. Instantâneo,
 *    sem perda. É o "instantâneo" da v0.1 que a v0.2 NÃO pode regredir.
 * 2. **`filter_complex` (concat filtro)** — degenerada mas com corte fora de
 *    quadro-chave / formatos misturados. O plano B da v0.1.
 * 3. **`filter_complex` (COMPILADOR da v0.2)** — assim que há 2ª trilha, overlay,
 *    crossfade, título, volume ou fade: a timeline vira um GRAFO (ver
 *    `filterComplexArgs` em `lib/args.ts`).
 *
 * O `degenerateClips` decide entre (1/2) e (3). A escolha entre (1) e (2) é o
 * `planExport`, igual à v0.1.
 */

type Phase = "idle" | "probing" | "ready" | "cutting" | "joining" | "encoding" | "done";

export interface ExportProgress {
  frac: number;
  etaSec: number | null;
  speed: string;
}

interface ExportState {
  open: boolean;
  phase: Phase;
  keyframes: Record<string, number[]>;
  /** O plano do caminho degenerado (copy/encode). `null` quando é o compilador. */
  plan: ExportPlan | null;
  /** A timeline usa recursos da v0.2 → vai pelo COMPILADOR de filter_complex. */
  useCompiler: boolean;
  snap: boolean;
  snapWouldHelp: boolean;
  outPath: string | null;
  progress: ExportProgress;
  result: { path: string; plan: ExportPlan | null; compiled: boolean; elapsedMs: number } | null;

  openDialog: () => Promise<void>;
  close: () => void;
  setSnap: (v: boolean) => void;
  setOutPath: (p: string) => void;
  run: () => Promise<void>;
  cancel: () => void;
}

let currentJob: string | null = null;
let canceling = false;

const ZERO: ExportProgress = { frac: 0, etaSec: null, speed: "" };

export const useExport = create<ExportState>((set, get) => ({
  open: false,
  phase: "idle",
  keyframes: {},
  plan: null,
  useCompiler: false,
  snap: false,
  snapWouldHelp: false,
  outPath: null,
  progress: ZERO,
  result: null,

  openDialog: async () => {
    const ed = useEditor.getState();
    const tl = ed.history.present;
    if (timelineDuration(tl) === 0) return;

    set({ open: true, phase: "probing", plan: null, result: null, progress: ZERO });

    // A timeline cabe no `-c copy` instantâneo? (1 trilha, em fila, sem v0.2)
    const flat = degenerateClips(tl);

    if (!flat) {
      // Compilador: nada de sondar quadro-chave (ele recodifica de qualquer jeito).
      if (!get().open) return;
      set({
        useCompiler: true,
        plan: { kind: "encode", clips: [], reason: { code: "encode-multitrack" } },
        snapWouldHelp: false,
        phase: "ready",
        outPath: get().outPath ?? (await defaultOut(firstPath(tl))),
      });
      return;
    }

    // Caminho degenerado: sonda de quadros-chave (um ffprobe por ARQUIVO).
    const paths = [...new Set(flat.map((c) => c.path))];
    const kf: Record<string, number[]> = { ...get().keyframes };
    for (const p of paths) {
      if (kf[p]) continue;
      try {
        const csv = await invoke<string>("probe_keyframes", { args: keyframeProbeArgs(p) });
        kf[p] = parseKeyframesCsv(csv);
      } catch {
        kf[p] = [];
      }
    }
    if (!get().open) return;

    const sources = buildSources(kf);
    const plan = planExport(flat, sources, { snap: get().snap });
    const snapped = planExport(flat, sources, { snap: true });
    set({
      keyframes: kf,
      useCompiler: false,
      plan,
      snapWouldHelp: plan.kind === "encode" && snapped.kind === "copy",
      phase: "ready",
      outPath: get().outPath ?? (await defaultOut(flat[0].path)),
    });
  },

  close: () => {
    if (isRunning(get().phase)) get().cancel();
    set({ open: false, phase: "idle", progress: ZERO });
  },

  setSnap: (snap) => {
    set({ snap });
    if (get().useCompiler) return;
    const flat = degenerateClips(useEditor.getState().history.present);
    if (!flat) return;
    const sources = buildSources(get().keyframes);
    set({ plan: planExport(flat, sources, { snap }) });
  },

  setOutPath: (outPath) => set({ outPath }),

  cancel: () => {
    canceling = true;
    if (currentJob) void invoke("ff_cancel", { jobId: currentJob });
  },

  run: async () => {
    const { plan, outPath, useCompiler } = get();
    if (!outPath || isRunning(get().phase)) return;
    if (!useCompiler && !plan) return;

    canceling = false;
    const started = Date.now();
    const totalMs = timelineDuration(useEditor.getState().history.present);
    const finalOut = await invoke<string>("unique_path", { path: outPath });
    const tmps: string[] = [];

    try {
      if (useCompiler) {
        await runCompile(finalOut, totalMs, set);
      } else if (plan!.kind === "copy") {
        await runCopy(plan!, finalOut, totalMs, tmps, set);
      } else {
        await runEncode(plan!, finalOut, totalMs, set);
      }

      set({
        phase: "done",
        result: { path: finalOut, plan, compiled: useCompiler, elapsedMs: Date.now() - started },
        progress: { frac: 1, etaSec: 0, speed: "" },
      });
    } catch (e) {
      set({ phase: "ready", progress: ZERO });
      const code = String(e);
      if (code === "canceled" || canceling) {
        useUi.getState().pushToast("info", t("exp.canceled"));
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

/** Caminho `-c copy`: o concat demuxer corta e cola numa passada só. */
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

/** Caminho `filter_complex` da v0.1 (concat filtro) — degenerada mas re-encode. */
async function runEncode(plan: ExportPlan, out: string, totalMs: number, set: Set): Promise<void> {
  set({ phase: "encoding" });
  const sources = buildSources(useExport.getState().keyframes);
  await runJob(encodeArgs(plan.clips, sources, out, {}), totalMs, 0, 1, set);
}

/** Caminho do COMPILADOR da v0.2: a timeline inteira vira um grafo. */
async function runCompile(out: string, totalMs: number, set: Set): Promise<void> {
  set({ phase: "encoding" });
  const ed = useEditor.getState();
  const sources = buildSources(useExport.getState().keyframes);
  const args = filterComplexArgs(ed.history.present, sources, out, {
    fontPath: ed.fontPath ?? undefined,
  });
  await runJob(args, totalMs, 0, 1, set);
}

/** Roda UM ffmpeg e vai empurrando o progresso. */
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
        const local = totalMs > 0 ? Math.min(1, e.payload.outTimeMs / totalMs) : 0;
        const frac = Math.min(1, base + local * span);
        const elapsed = (Date.now() - started) / 1000;
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

/** No `-c copy` ou todo mundo tem áudio, ou ninguém (o `planExport` já barrou a
 *  mistura antes de chegar aqui). */
function hasAudioEverywhere(clips: ExportClip[]): boolean {
  const media = useEditor.getState().media;
  return clips.every((c) => media[c.path]?.hasAudio);
}

/** Primeiro caminho de mídia da timeline (pra sugerir o destino). */
function firstPath(tl: { tracks: { clips: { path?: string }[] }[] }): string {
  for (const track of tl.tracks) for (const c of track.clips) if (c.path) return c.path;
  return "montagem.mp4";
}

/** Sugestão de destino: ao lado do primeiro vídeo, com nome que se entende. */
async function defaultOut(first: string): Promise<string> {
  const sep = first.includes("\\") ? "\\" : "/";
  const dir = first.slice(0, Math.max(first.lastIndexOf("\\"), first.lastIndexOf("/")));
  const stem = baseName(first).replace(/\.[^.]+$/, "");
  return `${dir ? `${dir}${sep}` : ""}${stem} - montagem.mp4`;
}

/** Duração total do filme montado — a UI mostra ao lado do plano. */
export function plannedDuration(): number {
  return timelineDuration(useEditor.getState().history.present);
}
