/**
 * O formato `.tvproj` — JSON com as trilhas, os clipes e os CAMINHOS da mídia.
 * Não guarda vídeo: um projeto de duas horas tem alguns KB, e abrir é
 * instantâneo. O preço é honesto e conhecido: mídia movida = projeto órfão, e
 * por isso o app confere os caminhos ao abrir e diz o que sumiu.
 *
 * ─── Versão no arquivo, migração na LEITURA ──────────────────────────────────
 *
 * A v0.1 salvava `version: 1` com uma lista rasa de clipes (uma trilha, em fila).
 * A v0.2 é multitrilha (`tracks`). Um `.tvproj` da v0.1 **tem que abrir** — nunca
 * quebrar o trabalho de quem já usava. Então a leitura MIGRA: vê `version: 1`,
 * remonta os clipes numa trilha de vídeo com `startMs` acumulado, e devolve a
 * timeline v0.2. Salvar sempre grava a versão nova.
 *
 * TS puro (testado). O Rust só grava/lê os bytes.
 */

import {
  TIMELINE_VERSION,
  type Clip,
  type Timeline,
  type TitleAnchor,
  type TitleProps,
  type Track,
  type TrackKind,
} from "./timeline";
import type { RawMediaInfo } from "./probe";

export { TIMELINE_VERSION as TVPROJ_VERSION };

export interface ProjectFile {
  app: "LocalVideo";
  version: number;
  /** Cache do que a sonda achou, por caminho: abrir não re-sonda tudo à toa. */
  media: Record<string, RawMediaInfo>;
  tracks: Track[];
}

/** Só a mídia REFERENCIADA vai pro arquivo: remover o último clipe de um vídeo
 *  tira o vídeo do projeto também, senão o `.tvproj` engorda com fantasmas. */
export function serializeProject(tl: Timeline, media: Record<string, RawMediaInfo>): string {
  const used = new Set<string>();
  for (const t of tl.tracks) for (const c of t.clips) if (c.path) used.add(c.path);
  const kept: Record<string, RawMediaInfo> = {};
  for (const [path, info] of Object.entries(media)) if (used.has(path)) kept[path] = info;

  const doc: ProjectFile = {
    app: "LocalVideo",
    version: TIMELINE_VERSION,
    media: kept,
    tracks: tl.tracks,
  };
  return JSON.stringify(doc, null, 2);
}

export class ProjectParseError extends Error {}

/**
 * Lê um `.tvproj`. Desconfiado de propósito: o arquivo veio do DISCO, pode ter
 * sido editado à mão, truncado por pen drive arrancado, ou ser de uma versão
 * futura. Ou entra INTEIRO, ou é erro — nunca uma timeline pela metade fingindo
 * que está tudo bem.
 */
export function parseProject(json: string): { timeline: Timeline; media: Record<string, RawMediaInfo> } {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new ProjectParseError("json");
  }
  if (!doc || typeof doc !== "object") throw new ProjectParseError("json");
  const d = doc as Record<string, unknown>;
  if (d.app !== "LocalVideo") throw new ProjectParseError("notOurs");
  if (typeof d.version !== "number" || d.version > TIMELINE_VERSION) {
    throw new ProjectParseError("newer");
  }

  const media = (d.media && typeof d.media === "object" ? d.media : {}) as Record<
    string,
    RawMediaInfo
  >;

  // v1: lista rasa de clipes em fila → migra pra uma trilha de vídeo.
  if (d.version === 1) {
    return { timeline: migrateV1(d.clips), media };
  }

  // v2: trilhas.
  if (!Array.isArray(d.tracks)) throw new ProjectParseError("json");
  const tracks = (d.tracks as unknown[]).map(parseTrack);
  // Garante ao menos uma trilha de vídeo (um projeto salvo vazio pode não ter).
  if (!tracks.some((t) => t.kind === "video")) {
    throw new ProjectParseError("json");
  }
  return { timeline: { version: TIMELINE_VERSION, tracks }, media };
}

let migSeq = 0;
function migId(prefix: string): string {
  migSeq += 1;
  return `${prefix}${migSeq}`;
}

/** Migra os clipes da v0.1 (em fila) pra uma timeline v0.2: trilha de vídeo com
 *  `startMs` acumulado + uma trilha de áudio vazia (pra ter onde soltar som). */
function migrateV1(rawClips: unknown): Timeline {
  if (!Array.isArray(rawClips)) throw new ProjectParseError("json");
  let cursor = 0;
  const clips: Clip[] = rawClips.map((raw, i) => {
    const c = raw as Record<string, unknown>;
    const ok =
      c &&
      typeof c.path === "string" &&
      c.path.length > 0 &&
      Number.isFinite(c.srcIn) &&
      Number.isFinite(c.srcOut) &&
      (c.srcOut as number) > (c.srcIn as number);
    if (!ok) throw new ProjectParseError("json");
    const srcIn = Math.max(0, Math.round(c.srcIn as number));
    const dur = Math.round(c.srcOut as number) - srcIn;
    const clip: Clip = {
      id: typeof c.id === "string" && c.id ? c.id : `p${i}`,
      startMs: cursor,
      durationMs: dur,
      path: c.path as string,
      srcIn,
    };
    cursor += dur;
    return clip;
  });
  return {
    version: TIMELINE_VERSION,
    tracks: [
      { id: migId("vt"), kind: "video", clips },
      { id: migId("at"), kind: "audio", clips: [] },
    ],
  };
}

function parseTrack(raw: unknown): Track {
  const t = raw as Record<string, unknown>;
  if (!t || (t.kind !== "video" && t.kind !== "audio") || !Array.isArray(t.clips)) {
    throw new ProjectParseError("json");
  }
  return {
    id: typeof t.id === "string" && t.id ? t.id : migId("tr"),
    kind: t.kind as TrackKind,
    clips: (t.clips as unknown[]).map(parseClip),
  };
}

function parseClip(raw: unknown): Clip {
  const c = raw as Record<string, unknown>;
  if (!c || !Number.isFinite(c.startMs) || !Number.isFinite(c.durationMs) || (c.durationMs as number) <= 0) {
    throw new ProjectParseError("json");
  }
  const base: Clip = {
    id: typeof c.id === "string" && c.id ? c.id : migId("c"),
    startMs: Math.max(0, Math.round(c.startMs as number)),
    durationMs: Math.round(c.durationMs as number),
  };
  // Mídia OU título — exatamente um dos dois.
  if (typeof c.path === "string" && c.path.length > 0) {
    base.path = c.path;
    base.srcIn = Number.isFinite(c.srcIn) ? Math.max(0, Math.round(c.srcIn as number)) : 0;
  } else if (c.title && typeof c.title === "object") {
    base.title = parseTitle(c.title as Record<string, unknown>);
  } else {
    throw new ProjectParseError("json");
  }
  // Propriedades opcionais de áudio/vídeo, só se forem números/booleanos sãos.
  if (typeof c.muted === "boolean") base.muted = c.muted;
  if (Number.isFinite(c.volume)) base.volume = c.volume as number;
  if (Number.isFinite(c.fadeInMs)) base.fadeInMs = Math.max(0, Math.round(c.fadeInMs as number));
  if (Number.isFinite(c.fadeOutMs)) base.fadeOutMs = Math.max(0, Math.round(c.fadeOutMs as number));
  if (Number.isFinite(c.opacity)) base.opacity = c.opacity as number;
  return base;
}

function parseTitle(t: Record<string, unknown>): TitleProps {
  const anchor: TitleAnchor =
    t.anchor === "top" || t.anchor === "center" || t.anchor === "bottom" ? t.anchor : "bottom";
  return {
    text: typeof t.text === "string" ? t.text : "",
    fontSizePx: Number.isFinite(t.fontSizePx) ? (t.fontSizePx as number) : 48,
    color: typeof t.color === "string" ? t.color : "#ffffff",
    anchor,
  };
}

/** Usado só pelos testes de migração pra ids previsíveis. */
export function __resetMigrationIds() {
  migSeq = 0;
}
