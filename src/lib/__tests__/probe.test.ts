import { describe, expect, it } from "vitest";
import {
  FALLBACK_FPS,
  effectiveFps,
  formatDuration,
  formatSize,
  formatTimecode,
  frameMs,
  gapAdvance,
  nearestThumb,
  parseFrameRate,
  stepFrames,
  thumbTimes,
  withFps,
  type RawMediaInfo,
} from "../probe";

const raw = (over: Partial<RawMediaInfo> = {}): RawMediaInfo => ({
  path: "a.mp4",
  durationMs: 10000,
  width: 1920,
  height: 1080,
  frameRate: "30/1",
  avgFrameRate: "30/1",
  videoCodec: "h264",
  audioCodec: "aac",
  hasAudio: true,
      audioTracks: [],
  streamCount: 2,
  sizeBytes: 1024,
  ...over,
});

describe("parseFrameRate — a fração do ffprobe", () => {
  it("converte o NTSC 30000/1001 em 29,97 (não em 30000)", () => {
    // O gotcha: parseFloat("30000/1001") devolveria 30000 e a timeline viraria pó.
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFloat("30000/1001")).toBe(30000); // a armadilha, cravada
  });

  it("cobre as taxas do mundo real", () => {
    expect(parseFrameRate("25/1")).toBe(25); // PAL
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("24000/1001")).toBeCloseTo(23.976, 3); // cinema
    expect(parseFrameRate("60000/1001")).toBeCloseTo(59.94, 2);
    expect(parseFrameRate("50/1")).toBe(50);
  });

  it("aceita número solto (nem todo campo vem em fração)", () => {
    expect(parseFrameRate("30")).toBe(30);
    expect(parseFrameRate(" 29.97 ")).toBeCloseTo(29.97, 2);
  });

  it("0/0, vazio e lixo viram 0 — não inventamos fps", () => {
    expect(parseFrameRate("0/0")).toBe(0); // stream sem taxa declarada
    expect(parseFrameRate("30/0")).toBe(0); // divisão por zero, não Infinity
    expect(parseFrameRate("0/1")).toBe(0);
    expect(parseFrameRate("")).toBe(0);
    expect(parseFrameRate(null)).toBe(0);
    expect(parseFrameRate(undefined)).toBe(0);
    expect(parseFrameRate("abc/def")).toBe(0);
    expect(parseFrameRate("-30/1")).toBe(0);
  });
});

describe("effectiveFps", () => {
  it("prefere a média real ao r_frame_rate absurdo do VFR", () => {
    // Vídeo de taxa variável: r_frame_rate estoura, avg diz a verdade.
    const i = raw({ frameRate: "1000/1", avgFrameRate: "30000/1001" });
    expect(effectiveFps(i)).toBeCloseTo(29.97, 2);
  });

  it("cai pro r_frame_rate quando não há média", () => {
    expect(effectiveFps(raw({ avgFrameRate: "0/0", frameRate: "25/1" }))).toBe(25);
  });

  it("sem taxa nenhuma usa o fallback (a grade das setas precisa de um número)", () => {
    expect(effectiveFps(raw({ avgFrameRate: "0/0", frameRate: "0/0" }))).toBe(FALLBACK_FPS);
    expect(withFps(raw({ avgFrameRate: "24000/1001" })).fps).toBeCloseTo(23.976, 3);
  });
});

describe("passo de quadro", () => {
  it("frameMs é o inverso do fps", () => {
    expect(frameMs(25)).toBe(40);
    expect(frameMs(30000 / 1001)).toBeCloseTo(33.367, 3);
    expect(frameMs(0)).toBeCloseTo(1000 / FALLBACK_FPS, 6);
  });

  it("as setas andam um quadro e param nas pontas", () => {
    expect(stepFrames(1000, 1, 25, 5000)).toBe(1040);
    expect(stepFrames(1000, -1, 25, 5000)).toBe(960);
    expect(stepFrames(0, -1, 25, 5000)).toBe(0); // não passa do começo
    expect(stepFrames(5000, 1, 25, 5000)).toBe(5000); // nem do fim
    expect(stepFrames(1000, 10, 25, 5000)).toBe(1400);
  });

  it("passo e timecode andam JUNTOS no NTSC — o atraso de 1 quadro, cravado", () => {
    // Regressão: um passo pra frente TEM que mudar o número do quadro na tela.
    // Antes, stepFrames(0,1,30)→33ms e formatTimecode(33,30) truncava pra "00".
    const fps = 30; // frameMs = 33,333… (não inteiro: é o que expunha o bug)
    const one = stepFrames(0, 1, fps, 60000);
    expect(formatTimecode(one, fps)).toBe("00:00:00:01");
    const two = stepFrames(one, 1, fps, 60000);
    expect(formatTimecode(two, fps)).toBe("00:00:00:02");
    // E sem DERIVA: 30 passos de um quadro caem exatamente em 1 s / quadro 0.
    let p = 0;
    for (let i = 0; i < 30; i++) p = stepFrames(p, 1, fps, 60000);
    expect(formatTimecode(p, fps)).toBe("00:00:01:00");
    // NTSC 29,97 idem: o índice de quadro anda sem escorregar.
    const ntsc = 30000 / 1001;
    let q = 0;
    for (let i = 0; i < 5; i++) q = stepFrames(q, 1, ntsc, 60000);
    expect(formatTimecode(q, ntsc)).toBe("00:00:00:05");
  });
});

describe("gapAdvance — correr pelo vazio", () => {
  it("anda o playhead pelo relógio de parede, na velocidade pedida", () => {
    // 16 ms de wall-clock a 1× ⇒ +16 ms; a 2× ⇒ +32 ms.
    expect(gapAdvance(1000, 16, 1, 5000)).toEqual({ playhead: 1016, ended: false });
    expect(gapAdvance(1000, 16, 2, 5000)).toEqual({ playhead: 1032, ended: false });
    // Somando quadro a quadro NÃO deriva: 10 passos de 16 ms caem em +160 ms.
    let p = 0;
    for (let i = 0; i < 10; i++) p = gapAdvance(p, 16, 1, 5000).playhead;
    expect(p).toBe(160);
  });

  it("prende no fim e SINALIZA quando o passo cruzaria a duração", () => {
    // O passo passaria de 5000 ⇒ crava em 5000 e diz que acabou (o chamador pausa).
    expect(gapAdvance(4990, 16, 1, 5000)).toEqual({ playhead: 5000, ended: true });
    // Exatamente no fim também conta como fim (não reagenda mais um quadro).
    expect(gapAdvance(5000, 16, 1, 5000)).toEqual({ playhead: 5000, ended: true });
    // Antes do fim, segue correndo.
    expect(gapAdvance(4000, 16, 1, 5000).ended).toBe(false);
  });

  it("rate <= 0 não recua aqui (a ré tem o seu próprio ticker) — trata como 1×", () => {
    // Blindagem: se por engano chamarem com 0/negativo, não trava nem anda pra
    // trás; usa 1× pra o tempo seguir em frente.
    expect(gapAdvance(1000, 16, 0, 5000)).toEqual({ playhead: 1016, ended: false });
    expect(gapAdvance(1000, 16, -2, 5000)).toEqual({ playhead: 1016, ended: false });
  });
});

describe("thumbTimes — miolo, nunca as bordas", () => {
  it("amostra o centro de cada fatia", () => {
    // 0..1000 em 2 fatias ⇒ 250 e 750. Nem 0 (tela preta) nem 1000 (créditos).
    expect(thumbTimes(0, 1000, 2)).toEqual([250, 750]);
    expect(thumbTimes(0, 1000, 4)).toEqual([125, 375, 625, 875]);
    expect(thumbTimes(0, 1000, 1)).toEqual([500]);
  });

  it("respeita o recorte do clipe (não o arquivo inteiro)", () => {
    expect(thumbTimes(2000, 3000, 2)).toEqual([2250, 2750]);
  });

  it("nunca toca as bordas exatas", () => {
    const ts = thumbTimes(0, 10000, 20);
    expect(ts[0]).toBeGreaterThan(0);
    expect(ts[ts.length - 1]).toBeLessThan(10000);
  });

  it("trecho invertido, vazio e contagem doida não explodem", () => {
    expect(thumbTimes(1000, 0, 2)).toEqual([250, 750]);
    expect(thumbTimes(500, 500, 3)).toEqual([500, 500, 500]);
    expect(thumbTimes(0, 100, 0)).toEqual([50]);
    expect(thumbTimes(0, 100, -5)).toEqual([50]);
    expect(thumbTimes(0, 100, 9999).length).toBe(400);
  });
});

describe("nearestThumb", () => {
  it("acha a miniatura mais perto do instante", () => {
    const times = [250, 750, 1250, 1750];
    expect(nearestThumb(times, 0)).toBe(0);
    expect(nearestThumb(times, 700)).toBe(1);
    expect(nearestThumb(times, 9999)).toBe(3);
    expect(nearestThumb([], 100)).toBe(-1); // tira ainda não extraída
  });
});

describe("tempo legível", () => {
  it("formatDuration mostra o que gente lê", () => {
    expect(formatDuration(0)).toBe("0:00.0");
    expect(formatDuration(64300)).toBe("1:04.3");
    expect(formatDuration(3723500)).toBe("1:02:03.5");
    expect(formatDuration(-10)).toBe("0:00.0");
  });

  it("formatTimecode conta QUADRO, como todo NLE", () => {
    expect(formatTimecode(0, 25)).toBe("00:00:00:00");
    expect(formatTimecode(1000, 25)).toBe("00:00:01:00");
    expect(formatTimecode(1040, 25)).toBe("00:00:01:01");
    expect(formatTimecode(3723000, 30)).toBe("01:02:03:00");
  });

  it("formatSize", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(20 * 1024 * 1024)).toBe("20 MB");
  });
});
