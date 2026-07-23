// Paridade com o editor do LocalMedia (B15, v0.14): imagem como clipe,
// rotação/espelho por clipe e fundo de título. Cada feature é provada onde mora
// o risco — o compilador de export (`filterComplexArgs`/`degenerateClips`), o
// modelo puro (`timeline.ts`) e o parser do `.tvproj` (`project.ts`).

import { beforeEach, describe, expect, it } from "vitest";

import { degenerateClips, filterComplexArgs, type SourceInfo } from "../args";
import { parseProject, serializeProject } from "../project";
import {
  __resetIds,
  hasSourceWindow,
  isImageClip,
  setClipEdge,
  setClipSpeed,
  splitAt,
  type Clip,
  type Timeline,
  type Track,
} from "../timeline";

beforeEach(() => __resetIds());

const A = "C:\\v\\a.mp4";
const IMG = "C:\\v\\foto.png";

function src(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    keyframesMs: [0, 1000, 2000, 3000],
    width: 640,
    height: 480,
    fps: 30,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    ...over,
  };
}
const vtrack = (clips: Clip[], id = "v1"): Track => ({ id, kind: "video", clips });
const tl = (tracks: Track[]): Timeline => ({ version: 4, tracks });
function fc(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1];
}

/* ------------------------------------------------------------------ */
/* Imagem como clipe                                                   */
/* ------------------------------------------------------------------ */

describe("imagem como clipe (B15)", () => {
  const imgClip = (over: Partial<Clip> = {}): Clip => ({
    id: "i", startMs: 0, durationMs: 5000, path: IMG, srcIn: 0, image: true, ...over,
  });

  it("é mídia, mas SEM janela-fonte", () => {
    const c = imgClip();
    expect(isImageClip(c)).toBe(true);
    expect(hasSourceWindow(c)).toBe(false);
  });

  it("entra no export com `-loop 1 -t <dur>` antes do `-i` (senão o png pisca e some)", () => {
    const a = filterComplexArgs(tl([vtrack([imgClip()])]), {}, "o.mp4");
    const i = a.indexOf(IMG);
    expect(a.slice(i - 5, i + 1)).toEqual(["-loop", "1", "-t", "5.000", "-i", IMG]);
  });

  it("o índice de entrada continua certo com vídeo E imagem misturados", () => {
    // O vídeo é a entrada 0, a imagem a 1 — mesmo a imagem gastando 6 args de -i.
    const t = tl([vtrack([
      { id: "v", startMs: 0, durationMs: 2000, path: A, srcIn: 0 },
      imgClip({ startMs: 2000 }),
    ])]);
    const a = filterComplexArgs(t, { [A]: src() }, "o.mp4");
    const g = fc(a);
    // A imagem é o input [1]: seu filtro puxa de `[1:v]`.
    expect(g).toContain("[1:v]");
    expect(a.indexOf(A)).toBeLessThan(a.indexOf(IMG));
  });

  it("NÃO cabe no `-c copy` (força o filter_complex)", () => {
    expect(degenerateClips(tl([vtrack([imgClip()])]))).toBeNull();
  });

  it("dividir a imagem NÃO avança srcIn (as duas metades mostram a mesma foto)", () => {
    const t = tl([vtrack([imgClip({ durationMs: 4000 })])]);
    const out = splitAt(t, "i", 1000);
    const [left, right] = out.tracks[0].clips;
    expect(left.durationMs).toBe(1000);
    expect(right.durationMs).toBe(3000);
    expect(right.srcIn).toBe(0); // NÃO 1000 — imagem não tem "mais adiante"
  });

  it("aparar a borda de saída estica LIVRE (sem limite de fim de arquivo)", () => {
    // Uma imagem foi solta com 5 s; puxar a borda pra 20 s vale, mesmo o `probe`
    // dizendo duração 0 (o editor passa `srcLimit` = undefined pra imagem).
    const t = tl([vtrack([imgClip({ durationMs: 5000 })])]);
    const out = setClipEdge(t, "i", "out", 20000, undefined, false);
    expect(out.tracks[0].clips[0].durationMs).toBe(20000);
  });

  it("velocidade é inerte numa imagem (não-evento)", () => {
    const t = tl([vtrack([imgClip()])]);
    expect(setClipSpeed(t, "i", 2)).toBe(t); // MESMA referência = não mudou nada
  });

  it("sobrevive ao ciclo salvar→abrir com a flag `image`", () => {
    const t = tl([vtrack([imgClip()])]);
    const back = parseProject(serializeProject(t, {}));
    expect(back.timeline.tracks[0].clips[0].image).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Rotação e espelho por clipe                                         */
/* ------------------------------------------------------------------ */

describe("rotação e espelho por clipe (B15)", () => {
  const rc = (over: Partial<Clip>): Clip => ({
    id: "c", startMs: 0, durationMs: 2000, path: A, srcIn: 0, ...over,
  });

  it("90° vira transpose=1; 270° vira transpose=2; 180° são dois transpose", () => {
    const g90 = fc(filterComplexArgs(tl([vtrack([rc({ rotate: 90 })])]), { [A]: src() }, "o.mp4"));
    expect(g90).toContain("transpose=1");
    const g270 = fc(filterComplexArgs(tl([vtrack([rc({ rotate: 270 })])]), { [A]: src() }, "o.mp4"));
    expect(g270).toContain("transpose=2");
    const g180 = fc(filterComplexArgs(tl([vtrack([rc({ rotate: 180 })])]), { [A]: src() }, "o.mp4"));
    expect(g180).toContain("transpose=1,transpose=1");
  });

  it("espelho vira hflip, DEPOIS da rotação na cadeia (bate com a prévia)", () => {
    const g = fc(filterComplexArgs(tl([vtrack([rc({ rotate: 90, flipH: true })])]), { [A]: src() }, "o.mp4"));
    expect(g).toContain("transpose=1,hflip");
  });

  it("rotação/espelho tiram do caminho `-c copy` (mexem no pixel)", () => {
    expect(degenerateClips(tl([vtrack([rc({ rotate: 90 })])]))).toBeNull();
    expect(degenerateClips(tl([vtrack([rc({ flipH: true })])]))).toBeNull();
  });

  it("sobrevivem ao ciclo salvar→abrir; valor inválido não entra", () => {
    const t = tl([vtrack([rc({ rotate: 180, flipH: true })])]);
    const back = parseProject(serializeProject(t, { [A]: src() as never }));
    const c = back.timeline.tracks[0].clips[0];
    expect(c.rotate).toBe(180);
    expect(c.flipH).toBe(true);
    // 45° (editado à mão) cai no "sem rotação".
    const doc = '{"app":"LocalVideo","version":4,"media":{},"tracks":[{"id":"v1","kind":"video","clips":[' +
      '{"id":"a","startMs":0,"durationMs":1000,"path":"v.mp4","srcIn":0,"rotate":45}]}]}';
    expect(parseProject(doc).timeline.tracks[0].clips[0].rotate).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Fundo de título                                                     */
/* ------------------------------------------------------------------ */

describe("fundo de título (B15)", () => {
  const titleClip = (bg?: string): Clip => ({
    id: "t", startMs: 0, durationMs: 2000,
    title: { text: "Oi", fontSizePx: 40, color: "#ffffff", anchor: "bottom", ...(bg ? { bg } : {}) },
  });

  it("com fundo → drawtext ganha box=1:boxcolor", () => {
    const g = fc(filterComplexArgs(tl([vtrack([titleClip("#000000")])]), {}, "o.mp4"));
    expect(g).toContain("box=1:boxcolor=#000000");
  });

  it("sem fundo → nenhuma box (comportamento até a v0.13)", () => {
    const g = fc(filterComplexArgs(tl([vtrack([titleClip()])]), {}, "o.mp4"));
    expect(g).not.toContain("box=1");
  });

  it("sobrevive ao ciclo salvar→abrir", () => {
    const back = parseProject(serializeProject(tl([vtrack([titleClip("#112233")])]), {}));
    expect(back.timeline.tracks[0].clips[0].title?.bg).toBe("#112233");
  });
});
