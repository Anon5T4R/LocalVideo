import { beforeEach, describe, expect, it } from "vitest";

import { applyMarkers, MarkerParseError, parseMarkers, sourceToTimeline } from "../markers";
import { __resetIds, type Track } from "../timeline";

const A = "C:\\rec\\aula.mp4";
const B = "C:\\rec\\outra.mp4";

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
    const track: Track = { clips: [{ id: "c1", path: A, srcIn: 0, srcOut: 10000 }] };
    expect(sourceToTimeline(track, A, 3000)).toEqual([3000]);
  });

  it("clipe aparado: o instante anda pra trás na timeline", () => {
    // O clipe começa aos 5 s do arquivo. O segundo 7 do arquivo é o segundo 2 do
    // filme. Quem confunde os dois corta 5 s fora do lugar.
    const track: Track = { clips: [{ id: "c1", path: A, srcIn: 5000, srcOut: 9000 }] };
    expect(sourceToTimeline(track, A, 7000)).toEqual([2000]);
  });

  it("instante aparado fora não aparece em lugar nenhum", () => {
    const track: Track = { clips: [{ id: "c1", path: A, srcIn: 5000, srcOut: 9000 }] };
    expect(sourceToTimeline(track, A, 1000)).toEqual([]);
    expect(sourceToTimeline(track, A, 9000)).toEqual([]); // srcOut é exclusivo
  });

  it("o mesmo segundo do arquivo em DOIS lugares do filme → dois instantes", () => {
    // O usuário duplicou o trecho. Um marcador ali é dois cortes.
    const track: Track = {
      clips: [
        { id: "c1", path: A, srcIn: 0, srcOut: 4000 },
        { id: "c2", path: A, srcIn: 0, srcOut: 4000 },
      ],
    };
    expect(sourceToTimeline(track, A, 1000)).toEqual([1000, 5000]);
  });

  it("ignora clipe de outro arquivo", () => {
    const track: Track = {
      clips: [
        { id: "c1", path: B, srcIn: 0, srcOut: 3000 },
        { id: "c2", path: A, srcIn: 0, srcOut: 3000 },
      ],
    };
    // O segundo 1 de A está no segundo 4 do filme (B ocupa os 3 primeiros).
    expect(sourceToTimeline(track, A, 1000)).toEqual([4000]);
  });
});

describe("applyMarkers — a ponte com o LocalRecord", () => {
  it("corta a timeline em cada marcador", () => {
    const track: Track = { clips: [{ id: "c1", path: A, srcIn: 0, srcOut: 10000 }] };
    const r = applyMarkers(track, A, [{ tMs: 3000 }, { tMs: 7000 }]);
    expect(r.applied).toBe(2);
    expect(r.skipped).toBe(0);
    // Um clipe virou três janelas sobre o MESMO arquivo — sem tocar em byte.
    expect(r.track.clips.map((c) => [c.srcIn, c.srcOut])).toEqual([
      [0, 3000],
      [3000, 7000],
      [7000, 10000],
    ]);
    expect(r.track.clips.every((c) => c.path === A)).toBe(true);
  });

  it("marcador em cima de emenda que já existe é não-evento, não erro", () => {
    const track: Track = {
      clips: [
        { id: "c1", path: A, srcIn: 0, srcOut: 5000 },
        { id: "c2", path: A, srcIn: 5000, srcOut: 9000 },
      ],
    };
    const r = applyMarkers(track, A, [{ tMs: 5000 }]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.track.clips.length).toBe(2);
  });

  it("marcador fora do que sobrou na timeline é contado, não escondido", () => {
    const track: Track = { clips: [{ id: "c1", path: A, srcIn: 4000, srcOut: 8000 }] };
    const r = applyMarkers(track, A, [{ tMs: 1000 }, { tMs: 6000 }]);
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("marcadores aplicados em sequência, cada um no clipe certo", () => {
    // O terceiro corte tem que achar o clipe que os dois anteriores criaram.
    const track: Track = { clips: [{ id: "c1", path: A, srcIn: 0, srcOut: 10000 }] };
    const r = applyMarkers(track, A, [{ tMs: 2000 }, { tMs: 4000 }, { tMs: 6000 }, { tMs: 8000 }]);
    expect(r.applied).toBe(4);
    expect(r.track.clips.length).toBe(5);
    expect(r.track.clips.map((c) => c.srcIn)).toEqual([0, 2000, 4000, 6000, 8000]);
  });

  it("não mexe em clipe de outro arquivo", () => {
    const track: Track = {
      clips: [
        { id: "c1", path: B, srcIn: 0, srcOut: 5000 },
        { id: "c2", path: A, srcIn: 0, srcOut: 5000 },
      ],
    };
    const r = applyMarkers(track, A, [{ tMs: 2000 }]);
    expect(r.applied).toBe(1);
    expect(r.track.clips.length).toBe(3);
    // O clipe de B saiu inteiro.
    expect(r.track.clips[0]).toEqual({ id: "c1", path: B, srcIn: 0, srcOut: 5000 });
  });

  it("não modifica a trilha original (o undo precisa do retrato de antes)", () => {
    const track: Track = { clips: [{ id: "c1", path: A, srcIn: 0, srcOut: 10000 }] };
    applyMarkers(track, A, [{ tMs: 3000 }]);
    expect(track.clips.length).toBe(1);
    expect(track.clips[0].srcOut).toBe(10000);
  });
});
