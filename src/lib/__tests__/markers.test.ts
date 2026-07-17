import { beforeEach, describe, expect, it } from "vitest";

import { applyMarkers, MarkerParseError, parseMarkers, sourceToTimeline } from "../markers";
import { __resetIds, srcOut, type Clip, type Timeline, type Track } from "../timeline";

const A = "C:\\rec\\aula.mp4";
const B = "C:\\rec\\outra.mp4";

const clip = (id: string, startMs: number, durationMs: number, srcIn: number, path: string): Clip => ({
  id,
  startMs,
  durationMs,
  path,
  srcIn,
});
const vtrack = (clips: Clip[]): Track => ({ id: "v1", kind: "video", clips });
const tl = (clips: Clip[]): Timeline => ({ version: 2, tracks: [vtrack(clips)] });

beforeEach(() => __resetIds());

describe("parseMarkers", () => {
  it("lê o formato documentado", () => {
    const json = JSON.stringify({
      app: "LocalRecord",
      version: 1,
      source: A,
      markers: [{ tMs: 42000, label: "fim" }, { tMs: 1500, label: "intro" }],
    });
    const f = parseMarkers(json);
    expect(f.source).toBe(A);
    // Ordenado: o arquivo pode vir na ordem em que a tecla foi apertada.
    expect(f.markers).toEqual([
      { tMs: 1500, label: "intro" },
      { tMs: 42000, label: "fim" },
    ]);
  });

  it("aceita array pelado de números (o script de três linhas)", () => {
    expect(parseMarkers("[3000, 1000]")).toEqual({
      markers: [{ tMs: 1000 }, { tMs: 3000 }],
      source: null,
    });
  });

  it("aceita array pelado de objetos", () => {
    expect(parseMarkers('[{"tMs":500,"label":"a"}]')).toEqual({
      markers: [{ tMs: 500, label: "a" }],
      source: null,
    });
  });

  it("marcador ruim não derruba os bons", () => {
    const json = JSON.stringify({
      markers: [{ tMs: 1000 }, { tMs: -5 }, { tMs: "abc" }, {}, null, { tMs: 2000 }],
    });
    expect(parseMarkers(json).markers).toEqual([{ tMs: 1000 }, { tMs: 2000 }]);
  });

  it("label vazio some (não vira legenda em branco na tela)", () => {
    expect(parseMarkers('[{"tMs":1,"label":""}]').markers).toEqual([{ tMs: 1 }]);
  });

  it("nenhum marcador válido É erro — 'importei!' sem cortar nada é a pior resposta", () => {
    expect(() => parseMarkers("[]")).toThrow(MarkerParseError);
    expect(() => parseMarkers('{"markers":[{"tMs":-1}]}')).toThrow(MarkerParseError);
  });

  it("json quebrado ou sem markers é erro, não meia-importação", () => {
    expect(() => parseMarkers("{isso não é json")).toThrow(MarkerParseError);
    expect(() => parseMarkers('{"app":"LocalRecord"}')).toThrow(MarkerParseError);
    expect(() => parseMarkers("null")).toThrow(MarkerParseError);
  });
});

describe("sourceToTimeline — tempo do ARQUIVO ≠ tempo do filme", () => {
  it("clipe inteiro e sozinho: os dois tempos coincidem", () => {
    const track = vtrack([clip("c1", 0, 10000, 0, A)]);
    expect(sourceToTimeline(track, A, 3000)).toEqual([3000]);
  });

  it("clipe aparado: o instante anda pra trás na timeline", () => {
    // Começa aos 5 s do arquivo. O segundo 7 do arquivo é o segundo 2 do filme.
    const track = vtrack([clip("c1", 0, 4000, 5000, A)]);
    expect(sourceToTimeline(track, A, 7000)).toEqual([2000]);
  });

  it("instante aparado fora não aparece em lugar nenhum", () => {
    const track = vtrack([clip("c1", 0, 4000, 5000, A)]); // srcIn 5000, srcOut 9000
    expect(sourceToTimeline(track, A, 1000)).toEqual([]);
    expect(sourceToTimeline(track, A, 9000)).toEqual([]); // srcOut é exclusivo
  });

  it("o mesmo segundo do arquivo em DOIS lugares do filme → dois instantes", () => {
    const track = vtrack([clip("c1", 0, 4000, 0, A), clip("c2", 4000, 4000, 0, A)]);
    expect(sourceToTimeline(track, A, 1000)).toEqual([1000, 5000]);
  });

  it("ignora clipe de outro arquivo", () => {
    const track = vtrack([clip("c1", 0, 3000, 0, B), clip("c2", 3000, 3000, 0, A)]);
    expect(sourceToTimeline(track, A, 1000)).toEqual([4000]);
  });
});

describe("applyMarkers — a ponte com o LocalRecord", () => {
  it("corta a timeline em cada marcador", () => {
    const t = tl([clip("c1", 0, 10000, 0, A)]);
    const r = applyMarkers(t, A, [{ tMs: 3000 }, { tMs: 7000 }]);
    expect(r.applied).toBe(2);
    expect(r.skipped).toBe(0);
    const clips = r.timeline.tracks[0].clips;
    expect(clips.map((c) => [c.srcIn, srcOut(c)])).toEqual([
      [0, 3000],
      [3000, 7000],
      [7000, 10000],
    ]);
    expect(clips.every((c) => c.path === A)).toBe(true);
  });

  it("marcador em cima de emenda que já existe é não-evento, não erro", () => {
    const t = tl([clip("c1", 0, 5000, 0, A), clip("c2", 5000, 4000, 5000, A)]);
    const r = applyMarkers(t, A, [{ tMs: 5000 }]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.timeline.tracks[0].clips.length).toBe(2);
  });

  it("marcador fora do que sobrou na timeline é contado, não escondido", () => {
    const t = tl([clip("c1", 0, 4000, 4000, A)]); // srcIn 4000, srcOut 8000
    const r = applyMarkers(t, A, [{ tMs: 1000 }, { tMs: 6000 }]);
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("marcadores aplicados em sequência, cada um no clipe certo", () => {
    const t = tl([clip("c1", 0, 10000, 0, A)]);
    const r = applyMarkers(t, A, [{ tMs: 2000 }, { tMs: 4000 }, { tMs: 6000 }, { tMs: 8000 }]);
    expect(r.applied).toBe(4);
    const clips = r.timeline.tracks[0].clips;
    expect(clips.length).toBe(5);
    expect(clips.map((c) => c.srcIn)).toEqual([0, 2000, 4000, 6000, 8000]);
  });

  it("não mexe em clipe de outro arquivo", () => {
    const t = tl([clip("c1", 0, 5000, 0, B), clip("c2", 5000, 5000, 0, A)]);
    const r = applyMarkers(t, A, [{ tMs: 2000 }]);
    expect(r.applied).toBe(1);
    expect(r.timeline.tracks[0].clips.length).toBe(3);
    expect(r.timeline.tracks[0].clips[0].id).toBe("c1");
  });

  it("não modifica a timeline original (o undo precisa do retrato de antes)", () => {
    const t = tl([clip("c1", 0, 10000, 0, A)]);
    applyMarkers(t, A, [{ tMs: 3000 }]);
    expect(t.tracks[0].clips.length).toBe(1);
    expect(srcOut(t.tracks[0].clips[0])).toBe(10000);
  });
});
