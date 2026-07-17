/**
 * O formato `.tvproj` — JSON com os clipes, a ordem e os cortes + os CAMINHOS
 * da mídia. Não guarda vídeo: um projeto de duas horas tem alguns KB, e abrir é
 * instantâneo. O preço é honesto e conhecido: mídia movida = projeto órfão, e
 * por isso o app confere os caminhos ao abrir e diz o que sumiu.
 *
 * TS puro (testado). O Rust só grava/lê os bytes.
 */

import type { Clip, Track } from "./timeline";
import type { RawMediaInfo } from "./probe";

export const TVPROJ_VERSION = 1;

export interface ProjectFile {
  app: "LocalVideo";
  version: number;
  /** Cache do que a sonda achou, por caminho: abrir não re-sonda tudo à toa. */
  media: Record<string, RawMediaInfo>;
  clips: Clip[];
}

export function serializeProject(track: Track, media: Record<string, RawMediaInfo>): string {
  // Só a mídia REFERENCIADA: remover o último clipe de um arquivo tem que tirar
  // o arquivo do projeto também, senão o .tvproj engorda com fantasmas.
  const used = new Set(track.clips.map((c) => c.path));
  const kept: Record<string, RawMediaInfo> = {};
  for (const [path, info] of Object.entries(media)) {
    if (used.has(path)) kept[path] = info;
  }
  const doc: ProjectFile = {
    app: "LocalVideo",
    version: TVPROJ_VERSION,
    media: kept,
    clips: track.clips,
  };
  return JSON.stringify(doc, null, 2);
}

export class ProjectParseError extends Error {}

/**
 * Lê um `.tvproj`. Desconfiado de propósito: o arquivo veio do DISCO, pode ter
 * sido editado à mão, truncado por pen drive arrancado, ou ser de uma versão
 * futura. Nada aqui pode deixar o app abrir com uma timeline meio montada
 * fingindo que está tudo bem — ou entra inteiro, ou é erro.
 */
export function parseProject(json: string): { track: Track; media: Record<string, RawMediaInfo> } {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new ProjectParseError("json");
  }
  if (!doc || typeof doc !== "object") throw new ProjectParseError("json");
  const d = doc as Partial<ProjectFile>;
  if (d.app !== "LocalVideo") throw new ProjectParseError("notOurs");
  if (typeof d.version !== "number" || d.version > TVPROJ_VERSION) {
    throw new ProjectParseError("newer");
  }
  if (!Array.isArray(d.clips)) throw new ProjectParseError("json");

  const clips: Clip[] = d.clips.map((c, i) => {
    const ok =
      c &&
      typeof c.path === "string" &&
      c.path.length > 0 &&
      Number.isFinite(c.srcIn) &&
      Number.isFinite(c.srcOut) &&
      c.srcOut > c.srcIn;
    if (!ok) throw new ProjectParseError("json");
    return {
      id: typeof c.id === "string" && c.id ? c.id : `p${i}`,
      path: c.path,
      srcIn: Math.max(0, Math.round(c.srcIn)),
      srcOut: Math.round(c.srcOut),
    };
  });

  const media = (d.media && typeof d.media === "object" ? d.media : {}) as Record<
    string,
    RawMediaInfo
  >;
  return { track: { clips }, media };
}
