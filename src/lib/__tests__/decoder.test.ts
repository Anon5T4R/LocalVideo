import { describe, expect, it } from "vitest";

import { canDecodeExactly, pickDecodeRange, pickFrameTs, type SampleMeta } from "../decoder";

/** Uma trilha de mentira: `gop` quadros por GOP, 30 fps. */
function samples(n: number, gop: number, fps = 30): SampleMeta[] {
  const dur = Math.round(1e6 / fps);
  return Array.from({ length: n }, (_, i) => ({
    tsUs: i * dur,
    durUs: dur,
    isSync: i % gop === 0,
  }));
}

describe("pickDecodeRange", () => {
  const s = samples(90, 30); // 3 s, quadro-chave a cada 1 s

  it("começa SEMPRE num quadro-chave (é o único ponto de partida possível)", () => {
    // Alvo no quadro 45 (1,5 s): o quadro-chave dele é o 30.
    const r = pickDecodeRange(s, 1_500_000)!;
    expect(r.start).toBe(30);
    expect(s[r.start].isSync).toBe(true);
  });

  it("decodifica o GOP INTEIRO, não só até o alvo (B-frames olham pra frente)", () => {
    const r = pickDecodeRange(s, 1_500_000)!;
    expect(r.end).toBe(59); // o quadro antes do próximo quadro-chave (60)
  });

  it("alvo no próprio quadro-chave: o GOP dele, começando nele", () => {
    const r = pickDecodeRange(s, 1_000_000)!;
    expect(r).toEqual({ start: 30, end: 59 });
  });

  it("primeiro GOP", () => {
    expect(pickDecodeRange(s, 0)).toEqual({ start: 0, end: 29 });
    expect(pickDecodeRange(s, 500_000)).toEqual({ start: 0, end: 29 });
  });

  it("último GOP vai até o fim do arquivo", () => {
    expect(pickDecodeRange(s, 2_900_000)).toEqual({ start: 60, end: 89 });
  });

  it("antes do começo e depois do fim grudam nas pontas, sem explodir", () => {
    expect(pickDecodeRange(s, -5000)).toEqual({ start: 0, end: 29 });
    expect(pickDecodeRange(s, 99_000_000)).toEqual({ start: 60, end: 89 });
  });

  it("tudo quadro-chave (todo GOP de 1): decodifica um quadro só", () => {
    const all = samples(10, 1);
    expect(pickDecodeRange(all, 100_000)).toEqual({ start: 3, end: 3 });
  });

  it("arquivo sem quadro-chave declarado além do 1º: volta lá pro começo", () => {
    const weird = samples(50, 999);
    expect(pickDecodeRange(weird, 1_000_000)).toEqual({ start: 0, end: 49 });
  });

  it("o range SEMPRE contém o alvo — a invariante que faz a seta funcionar", () => {
    for (let f = 0; f < 90; f++) {
      const t = f * Math.round(1e6 / 30);
      const r = pickDecodeRange(s, t)!;
      expect(r.start).toBeLessThanOrEqual(f);
      expect(r.end).toBeGreaterThanOrEqual(f);
      expect(s[r.start].isSync).toBe(true);
    }
  });

  it("ordem de decodificação ≠ ordem de apresentação (B-frames)", () => {
    // Padrão IPB real: o P do cts 3 está guardado ANTES dos B de cts 1 e 2.
    // Procurar o alvo por índice, e não por cts, entregaria o quadro errado.
    const b: SampleMeta[] = [
      { tsUs: 0, durUs: 1000, isSync: true }, // I (dec 0)
      { tsUs: 3000, durUs: 1000, isSync: false }, // P (dec 1)
      { tsUs: 1000, durUs: 1000, isSync: false }, // B (dec 2)
      { tsUs: 2000, durUs: 1000, isSync: false }, // B (dec 3)
      { tsUs: 4000, durUs: 1000, isSync: true }, // I (dec 4)
    ];
    // O alvo é o cts 2000 (índice de decodificação 3) — e o GOP dele é 0..3.
    expect(pickDecodeRange(b, 2000)).toEqual({ start: 0, end: 3 });
  });

  it("lista vazia é null, não chute", () => {
    expect(pickDecodeRange([], 0)).toBe(null);
  });
});

describe("pickFrameTs", () => {
  it("mostra o quadro que JÁ começou, nunca o do futuro", () => {
    // 1900 está mais PERTO de 2000, mas o quadro de 2000 é futuro: no instante
    // 1900 o olho vê o quadro que começou em 1000.
    expect(pickFrameTs([0, 1000, 2000], 1900)).toBe(1000);
  });

  it("em cima do quadro, é o quadro", () => {
    expect(pickFrameTs([0, 1000, 2000], 1000)).toBe(1000);
  });

  it("antes do primeiro quadro mostra o primeiro (é o começo do vídeo, não erro)", () => {
    expect(pickFrameTs([500, 1000], 0)).toBe(500);
  });

  it("depois do último, o último", () => {
    expect(pickFrameTs([0, 1000], 99999)).toBe(1000);
  });

  it("fora de ordem (é a ordem de decodificação) não engana", () => {
    expect(pickFrameTs([0, 3000, 1000, 2000], 2500)).toBe(2000);
  });

  it("vazio é null", () => {
    expect(pickFrameTs([], 0)).toBe(null);
  });
});

describe("canDecodeExactly", () => {
  it("sem VideoDecoder, não promete precisão — nem pra mp4", () => {
    // No vitest (node) não existe VideoDecoder. É exatamente o que se espera:
    // sem o decodificador, a resposta honesta é `false`.
    expect(typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder).toBe("undefined");
    expect(canDecodeExactly("C:\\v\\a.mp4")).toBe(false);
  });

  it("o demuxer é o limite: só MP4/MOV/M4V teriam chance", () => {
    // Com VideoDecoder fingido, o que decide é o container — o mp4box não abre
    // mkv/webm/avi, e nesses casos o app degrada e AVISA.
    const w = globalThis as { VideoDecoder?: unknown; window?: unknown };
    const hadWindow = "window" in globalThis;
    w.window = w;
    w.VideoDecoder = function () {};
    try {
      expect(canDecodeExactly("C:\\v\\a.mp4")).toBe(true);
      expect(canDecodeExactly("C:\\v\\a.MOV")).toBe(true);
      expect(canDecodeExactly("/home/j/b.m4v")).toBe(true);
      expect(canDecodeExactly("C:\\v\\a.mkv")).toBe(false);
      expect(canDecodeExactly("C:\\v\\a.webm")).toBe(false);
      expect(canDecodeExactly("C:\\v\\a.avi")).toBe(false);
      expect(canDecodeExactly("sem-extensao")).toBe(false);
    } finally {
      delete w.VideoDecoder;
      if (!hadWindow) delete w.window;
    }
  });
});
