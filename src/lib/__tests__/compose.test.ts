import { describe, expect, it } from "vitest";

import {
  colorToCanvasFilter,
  crossfadeAlpha,
  envelopeAt,
  layersAt,
  needsComposite,
  type MediaLayer,
} from "../compose";
import type { Clip, Timeline, Track } from "../timeline";

const media = (id: string, startMs: number, durationMs: number, over: Partial<Clip> = {}): Clip => ({
  id,
  startMs,
  durationMs,
  path: `${id}.mp4`,
  srcIn: 0,
  ...over,
});
const vtrack = (clips: Clip[], id = "v1"): Track => ({ id, kind: "video", clips });
const tl = (tracks: Track[]): Timeline => ({ version: 2, tracks });

describe("envelopeAt — interpolação do envelope na prévia", () => {
  const kf = [
    { t: 0, v: 0 },
    { t: 0.5, v: 1 },
    { t: 1, v: 0.2 },
  ];
  it("interpola linear entre os pontos", () => {
    expect(envelopeAt(kf, 0)).toBe(0);
    expect(envelopeAt(kf, 0.25)).toBeCloseTo(0.5);
    expect(envelopeAt(kf, 0.5)).toBe(1);
    expect(envelopeAt(kf, 0.75)).toBeCloseTo(0.6);
  });
  it("prende nas pontas fora do intervalo", () => {
    expect(envelopeAt(kf, -1)).toBe(0);
    expect(envelopeAt(kf, 2)).toBe(0.2);
  });
});

describe("crossfadeAlpha — o dissolve da prévia", () => {
  it("o clipe de cima ENTRA (0→1) durante a sobreposição", () => {
    // a=[0,3000), b começa em 2000 → 1000 ms de sobreposição.
    const track = vtrack([media("a", 0, 3000), media("b", 2000, 3000)]);
    // No começo da sobreposição, b quase invisível; no fim, cheio.
    expect(crossfadeAlpha(track, 1, 2000)).toBeCloseTo(0);
    expect(crossfadeAlpha(track, 1, 2500)).toBeCloseTo(0.5);
    expect(crossfadeAlpha(track, 1, 3000)).toBe(1); // acabou a transição
  });
  it("sem sobreposição, alfa cheio", () => {
    const track = vtrack([media("a", 0, 2000), media("b", 2000, 2000)]);
    expect(crossfadeAlpha(track, 1, 2000)).toBe(1);
  });
});

describe("layersAt — as camadas no instante t (ordem = a do export)", () => {
  it("empilha trilhas de baixo pra cima e resolve o tempo-fonte", () => {
    const t = tl([
      vtrack([media("a", 0, 4000, { srcIn: 1000 })]),
      vtrack([media("b", 0, 2000, { transform: { x: 0.5, y: 0.5, scale: 0.3 } })], "v2"),
    ]);
    const ls = layersAt(t, 1000);
    expect(ls.map((l) => (l.kind === "media" ? l.clip.id : "title"))).toEqual(["a", "b"]);
    // a: srcIn 1000 + 1000 de timeline = 2000 na fonte.
    expect((ls[0] as MediaLayer).srcTimeMs).toBe(2000);
  });

  it("clipe acelerado mapeia o tempo-fonte pela velocidade", () => {
    const t = tl([vtrack([media("a", 0, 2000, { srcIn: 0, speed: 2 })])]);
    // 500 ms de timeline @2× → 1000 ms de fonte.
    expect((layersAt(t, 500)[0] as MediaLayer).srcTimeMs).toBe(1000);
  });

  it("opacidade por envelope entra no alfa da camada", () => {
    const t = tl([vtrack([media("a", 0, 2000, { opacityKeyframes: [{ t: 0, v: 0 }, { t: 1, v: 1 }] })])]);
    expect((layersAt(t, 1000)[0] as MediaLayer).alpha).toBeCloseTo(0.5);
  });

  it("cor marca a camada como aproximada (prévia não é fiel na cor)", () => {
    const t = tl([vtrack([media("a", 0, 2000, { color: { brightness: 0.2, contrast: 1, saturation: 1 } })])]);
    expect((layersAt(t, 500)[0] as MediaLayer).approx).toBe(true);
  });

  it("buraco entre clipes não gera camada", () => {
    const t = tl([vtrack([media("a", 0, 1000), media("b", 3000, 1000)])]);
    expect(layersAt(t, 2000)).toEqual([]);
  });
});

describe("wipe/slide na prévia (v0.4.1) — a MESMA fronteira do export", () => {
  // a=[0,3000) com transitionKind; b entra em 2000 → 1 s de sobreposição.
  const withKind = (kind?: "wipe" | "slide" | "dissolve", bOver: Partial<Clip> = {}) =>
    tl([
      vtrack([
        media("a", 0, 3000, kind ? { transitionKind: kind } : {}),
        media("b", 2000, 3000, bOver),
      ]),
    ]);

  it("wipe: a camada entra OPACA com o progresso em transition (não no alfa)", () => {
    const ls = layersAt(withKind("wipe"), 2500); // meio da sobreposição
    const b = ls[1] as MediaLayer;
    // O alfa fica cheio — quem recorta é o desenho, na fronteira W·progress.
    expect(b.alpha).toBe(1);
    expect(b.transition).toEqual({ kind: "wipe", progress: 0.5 });
  });

  it("slide idem, com o kind certo", () => {
    const b = layersAt(withKind("slide"), 2250)[1] as MediaLayer;
    expect(b.alpha).toBe(1);
    expect(b.transition?.kind).toBe("slide");
    expect(b.transition?.progress).toBeCloseTo(0.25);
  });

  it("dissolve (padrão) segue no alfa, sem transition espacial", () => {
    const b = layersAt(withKind(undefined), 2500)[1] as MediaLayer;
    expect(b.alpha).toBeCloseTo(0.5);
    expect(b.transition).toBeUndefined();
  });

  it("fora da janela da sobreposição, transition some (terminou = opaco)", () => {
    // Em 3500 o clipe a já acabou: só b está ativo (é a única camada).
    const ls = layersAt(withKind("wipe"), 3500);
    expect(ls).toHaveLength(1);
    const b = ls[0] as MediaLayer;
    expect(b.alpha).toBe(1);
    expect(b.transition).toBeUndefined();
  });

  it("PiP entrando cai no dissolve — espelha o compilador", () => {
    const b = layersAt(
      withKind("wipe", { transform: { x: 0.5, y: 0.5, scale: 0.3 } }),
      2500,
    )[1] as MediaLayer;
    expect(b.transition).toBeUndefined();
    expect(b.alpha).toBeCloseTo(0.5); // dissolve de sempre
  });

  it("wipe respeita a opacidade constante do clipe (multiplica)", () => {
    const b = layersAt(withKind("wipe", { opacity: 0.5 }), 2500)[1] as MediaLayer;
    expect(b.alpha).toBeCloseTo(0.5);
    expect(b.transition?.kind).toBe("wipe");
  });
});

describe("needsComposite — quando vale compor no canvas", () => {
  it("uma trilha simples NÃO precisa compor (mostra o <video>)", () => {
    const t = tl([vtrack([media("a", 0, 2000)])]);
    expect(needsComposite(layersAt(t, 500))).toBe(false);
  });
  it("PiP, título, opacidade, cor ou 2ª camada PRECISAM compor", () => {
    const pip = tl([vtrack([media("a", 0, 2000, { transform: { x: 0, y: 0, scale: 0.5 } })])]);
    expect(needsComposite(layersAt(pip, 500))).toBe(true);
    const op = tl([vtrack([media("a", 0, 2000, { opacity: 0.5 })])]);
    expect(needsComposite(layersAt(op, 500))).toBe(true);
  });
});

describe("colorToCanvasFilter — aproxima o eq (e o app avisa)", () => {
  it("brilho aditivo vira multiplicativo aproximado", () => {
    expect(colorToCanvasFilter({ brightness: 0, contrast: 1, saturation: 1 })).toBe(
      "brightness(1.000) contrast(1.000) saturate(1.000)",
    );
    expect(colorToCanvasFilter({ brightness: 0.2, contrast: 1.5, saturation: 0.5 })).toBe(
      "brightness(1.200) contrast(1.500) saturate(0.500)",
    );
  });
});
