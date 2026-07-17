import { describe, expect, it } from "vitest";

import { audioGainAt, audioLayersAt, hasMixAudio } from "../audiomix";
import type { Clip, Timeline, Track } from "../timeline";

const media = (id: string, startMs: number, durationMs: number, over: Partial<Clip> = {}): Clip => ({
  id,
  startMs,
  durationMs,
  path: `${id}.mp4`,
  srcIn: 0,
  ...over,
});
const track = (id: string, kind: "video" | "audio", clips: Clip[]): Track => ({ id, kind, clips });
const tl = (tracks: Track[]): Timeline => ({ version: 2, tracks });

describe("audioGainAt — o ganho da mixagem na prévia", () => {
  it("volume constante passa direto", () => {
    expect(audioGainAt(media("a", 0, 4000, { volume: 0.5 }), 2000)).toBeCloseTo(0.5);
    // Sem volume = 1 (original).
    expect(audioGainAt(media("a", 0, 4000), 2000)).toBe(1);
  });

  it("fade in/out são rampas lineares nas pontas", () => {
    const c = media("a", 1000, 4000, { fadeInMs: 1000, fadeOutMs: 1000 });
    expect(audioGainAt(c, 1000)).toBeCloseTo(0); // início do fade-in
    expect(audioGainAt(c, 1500)).toBeCloseTo(0.5); // meio do fade-in
    expect(audioGainAt(c, 3000)).toBeCloseTo(1); // miolo, cheio
    expect(audioGainAt(c, 4500)).toBeCloseTo(0.5); // meio do fade-out
    expect(audioGainAt(c, 5000)).toBeCloseTo(0); // fim
  });

  it("fade multiplica o volume constante", () => {
    const c = media("a", 0, 2000, { volume: 0.8, fadeInMs: 1000 });
    expect(audioGainAt(c, 500)).toBeCloseTo(0.4); // 0,8 × 0,5
  });

  it("keyframes de volume têm precedência sobre o volume constante", () => {
    const c = media("a", 0, 2000, {
      volume: 0.2, // ignorado quando há envelope
      volumeKeyframes: [
        { t: 0, v: 0 },
        { t: 1, v: 1 },
      ],
    });
    expect(audioGainAt(c, 0)).toBeCloseTo(0);
    expect(audioGainAt(c, 1000)).toBeCloseTo(0.5);
    expect(audioGainAt(c, 2000)).toBeCloseTo(1);
  });

  it("PRENDE o ganho em 1 — o <audio> não amplifica (o export sim)", () => {
    // volume 2× pediria ganho 2, mas a prévia não passa de 1.0.
    expect(audioGainAt(media("a", 0, 2000, { volume: 2 }), 1000)).toBe(1);
  });
});

describe("audioLayersAt — quem toca, fora da base", () => {
  it("a trilha BASE fica de fora (o <video> já toca o som dela)", () => {
    const t = tl([
      track("v1", "video", [media("base", 0, 5000)]),
      track("a1", "audio", [media("music", 0, 5000, { volume: 0.4 })]),
    ]);
    const layers = audioLayersAt(t, 2000, "v1");
    expect(layers).toHaveLength(1);
    expect(layers[0].clipId).toBe("music");
    expect(layers[0].gain).toBeCloseTo(0.4);
  });

  it("pula clipe MUDO, título e o que está fora do instante", () => {
    const t = tl([
      track("v1", "video", [media("base", 0, 5000)]),
      track("a1", "audio", [
        media("m1", 0, 2000, { muted: true }),
        media("m2", 2000, 2000),
        { id: "cap", startMs: 0, durationMs: 5000, title: { text: "x", fontSizePx: 40, color: "#fff", anchor: "bottom" } },
      ]),
    ]);
    // Em 1000: m1 está sob o playhead mas é mudo → nada; título não é áudio.
    expect(audioLayersAt(t, 1000, "v1")).toHaveLength(0);
    // Em 3000: m2 toca.
    const at3 = audioLayersAt(t, 3000, "v1");
    expect(at3.map((l) => l.clipId)).toEqual(["m2"]);
  });

  it("o tempo-fonte considera srcIn e velocidade", () => {
    const t = tl([
      track("v1", "video", [media("base", 0, 5000)]),
      // clipe começa em 1000 na timeline, janela do arquivo a partir de 500 ms, 2×.
      track("a1", "audio", [media("m", 1000, 2000, { srcIn: 500, speed: 2 })]),
    ]);
    // Em 1500 (500 ms dentro do clipe) → 500 + 500×2 = 1500 ms de fonte.
    expect(audioLayersAt(t, 1500, "v1")[0].srcTimeMs).toBe(1500);
  });
});

describe("hasMixAudio — há trilha de fundo pra mixar?", () => {
  it("false só com a base; true assim que entra uma 2ª trilha com áudio", () => {
    const soBase = tl([track("v1", "video", [media("base", 0, 5000)])]);
    expect(hasMixAudio(soBase, "v1")).toBe(false);
    const comMusica = tl([
      track("v1", "video", [media("base", 0, 5000)]),
      track("a1", "audio", [media("m", 0, 5000)]),
    ]);
    expect(hasMixAudio(comMusica, "v1")).toBe(true);
    // Trilha de fundo só com clipe MUDO não conta.
    const soMudo = tl([
      track("v1", "video", [media("base", 0, 5000)]),
      track("a1", "audio", [media("m", 0, 5000, { muted: true })]),
    ]);
    expect(hasMixAudio(soMudo, "v1")).toBe(false);
  });
});
