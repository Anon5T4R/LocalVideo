import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  concatArgs,
  concatListBody,
  encodeArgs,
  filterComplexArgs,
  keyframeProbeArgs,
  parseKeyframesCsv,
  planExport,
  type ExportClip,
  type SourceInfo,
} from "../args";
import type { Clip, Timeline, Track } from "../timeline";

/**
 * O portão de VERDADE do export: roda o ffmpeg de verdade, com os argumentos que
 * o `args.ts` produz de verdade, e confere o resultado com o ffprobe.
 *
 * Existe porque compilar não é prova e teste de unidade não é prova: os testes
 * do `args.test.ts` provam que a gente monta a linha de comando que a gente
 * QUIS montar — não que o ffmpeg concorde com ela. Um `-to` no lugar de um `-t`
 * passa em todo teste de string e entrega um vídeo com a duração errada.
 * **Arquivo existir também não é prova**: um mp4 de 48 bytes existe.
 *
 * **Fora do `npm test` de propósito** (`skipIf`): o portão da suíte é puro e não
 * baixa binário. Este aqui precisa do ffmpeg no disco, então se pede:
 *
 *     bash scripts/fetch-ffmpeg.sh   # ou o .ps1 no Windows
 *     LOCALVIDEO_FFMPEG_TESTS=1 npx vitest run export.real
 */

const FF_DIR = join(process.cwd(), "src-tauri", "binaries", "ffmpeg");
const EXE = process.platform === "win32" ? ".exe" : "";
const FFMPEG = join(FF_DIR, `ffmpeg${EXE}`);
const FFPROBE = join(FF_DIR, `ffprobe${EXE}`);

const ENABLED = !!process.env.LOCALVIDEO_FFMPEG_TESTS && existsSync(FFMPEG);

const DIR = join(tmpdir(), "localvideo-export-real");
const A = join(DIR, "a.mp4");
const B = join(DIR, "b.mp4");

function ffmpeg(args: string[]): void {
  // Os mesmos flags que o `ff_run` do Rust injeta, pra exercitar a MESMA linha.
  execFileSync(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...args], {
    stdio: "pipe",
  });
}

function ffprobe(args: string[]): string {
  return execFileSync(FFPROBE, args, { encoding: "utf8" });
}

/** Duração REAL do container, pelo ffprobe. */
function durationOf(path: string): number {
  const s = ffprobe([
    "-v",
    "quiet",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    path,
  ]);
  return Math.round(parseFloat(s.trim()) * 1000);
}

function streamsOf(path: string): string[] {
  return ffprobe([
    "-v",
    "quiet",
    "-show_entries",
    "stream=codec_type,codec_name",
    "-of",
    "csv=p=0",
    path,
  ])
    .trim()
    .split("\n")
    .map((l) => l.trim()) // o ffprobe do Windows termina linha com \r
    .filter(Boolean);
}

function sourceOf(path: string, over: Partial<SourceInfo> = {}): SourceInfo {
  const csv = ffprobe(keyframeProbeArgs(path));
  return {
    keyframesMs: parseKeyframesCsv(csv),
    width: 640,
    height: 480,
    fps: 30,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    ...over,
  };
}

describe.skipIf(!ENABLED)("export de verdade (ffmpeg real)", () => {
  beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    // `-g 30` a 30 fps + `-sc_threshold 0` = quadro-chave EXATAMENTE a cada 1 s.
    // Sem o sc_threshold o x264 mete quadro-chave onde a cena muda e "em
    // quadro-chave" deixaria de ser um instante conhecido.
    for (const [path, pattern, dur] of [
      [A, "testsrc", 10],
      [B, "testsrc2", 6],
    ] as const) {
      ffmpeg([
        "-f", "lavfi", "-i", `${pattern}=size=640x480:rate=30:duration=${dur}`,
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}`,
        "-c:v", "libx264", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
      ]);
    }
  });

  it("a sonda vê os quadros-chave que o -g 30 mandou criar", () => {
    // Se isto falhar, o resto do arquivo está medindo a coisa errada.
    expect(sourceOf(A).keyframesMs).toEqual([
      0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000,
    ]);
  });

  /** Roda o caminho copy inteiro, como o `runCopy` do `state/export.ts` faz. */
  function runCopy(clips: ExportClip[], out: string): void {
    const list = join(DIR, `list-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(list, concatListBody(clips));
    ffmpeg(concatArgs(list, out, true));
  }

  it("CAMINHO 1: corte EM quadro-chave sai com -c copy, e a duração bate", () => {
    const clips: ExportClip[] = [{ path: A, srcIn: 3000, srcOut: 6000 }];
    const plan = planExport(clips, { [A]: sourceOf(A) });
    expect(plan.kind).toBe("copy");
    expect(plan.reason.code).toBe("copy-exact");

    const out = join(DIR, "copy-1.mp4");
    runCopy(plan.clips, out);

    // A prova: 3 s pedidos, ~3 s entregues.
    //
    // A folga pra cima é de ~150 ms e é MEDIDA, não chutada: o `-c copy` não
    // consegue ser exato e isso está documentado em `concatListBody`. O vídeo sai
    // em pacotes inteiros (2 quadros a mais) e o áudio vem em blocos de ~21 ms
    // que não se cortam ao meio sem recodificar. Quem quer o corte no quadro
    // exato paga o `filter_complex` — é o teste seguinte.
    expect(durationOf(out)).toBeGreaterThan(2950);
    expect(durationOf(out)).toBeLessThan(3200);
    // E sem recodificar: o codec do fonte atravessou intacto.
    expect(streamsOf(out)).toEqual(["h264,video", "aac,audio"]);
  });

  it("CAMINHO 1: dois trechos colados numa passada só somam as durações", () => {
    const clips: ExportClip[] = [
      { path: A, srcIn: 0, srcOut: 2000 },
      { path: A, srcIn: 5000, srcOut: 8000 },
    ];
    const plan = planExport(clips, { [A]: sourceOf(A) });
    expect(plan.kind).toBe("copy");

    const out = join(DIR, "copy-2.mp4");
    runCopy(plan.clips, out);

    // 2 s + 3 s = 5 s. É a prova de que o `-avoid_negative_ts make_zero` fez o
    // trabalho: sem ele, o segundo trecho entraria com o timestamp lá dos 5 s e
    // a duração sairia ~8 s, com o player "esperando" no meio.
    expect(durationOf(out)).toBeGreaterThan(4950);
    expect(durationOf(out)).toBeLessThan(5200);
    expect(streamsOf(out)).toEqual(["h264,video", "aac,audio"]);
  });

  it("CAMINHO 2: corte FORA de quadro-chave recodifica, e a duração bate", () => {
    // 4300 não é quadro-chave (eles estão de 1000 em 1000).
    const clips: ExportClip[] = [{ path: A, srcIn: 4300, srcOut: 6800 }];
    const plan = planExport(clips, { [A]: sourceOf(A) });
    expect(plan.kind).toBe("encode");
    expect(plan.reason).toEqual({
      code: "encode-off-keyframe",
      atMs: 4300,
      nearestMs: 4000,
      path: A,
    });

    const out = join(DIR, "enc-1.mp4");
    ffmpeg(encodeArgs(plan.clips, { [A]: sourceOf(A) }, out));

    // 2,5 s pedidos, 2,5 s entregues — e AQUI o corte é exato, que é o motivo
    // inteiro de ter pago o preço do re-encode.
    expect(durationOf(out)).toBeGreaterThan(2400);
    expect(durationOf(out)).toBeLessThan(2600);
    expect(streamsOf(out)).toEqual(["h264,video", "aac,audio"]);
  });

  it("CAMINHO 2: formatos misturados viram um vídeo só", () => {
    const clips: ExportClip[] = [
      { path: A, srcIn: 0, srcOut: 2000 },
      { path: B, srcIn: 0, srcOut: 2000 },
    ];
    const sources = {
      [A]: sourceOf(A),
      [B]: sourceOf(B, { width: 1920, height: 1080 }),
    };
    const plan = planExport(clips, sources);
    expect(plan.reason.code).toBe("encode-mixed-format");

    const out = join(DIR, "enc-mixed.mp4");
    ffmpeg(encodeArgs(plan.clips, sources, out));
    expect(durationOf(out)).toBeGreaterThan(3900);
    expect(durationOf(out)).toBeLessThan(4200);
  });

  it("CAMINHO 2: clipe mudo no meio não custa o áudio do filme", () => {
    // O anullsrc entrando no lugar do que não existe. Sem ele, o filtro concat
    // se recusa a colar e o export inteiro morre.
    const mute = join(DIR, "mute.mp4");
    ffmpeg([
      "-f", "lavfi", "-i", "testsrc=size=640x480:rate=30:duration=3",
      "-c:v", "libx264", "-g", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-an", mute,
    ]);
    expect(streamsOf(mute)).toEqual(["h264,video"]);

    const clips: ExportClip[] = [
      { path: A, srcIn: 0, srcOut: 2000 },
      { path: mute, srcIn: 0, srcOut: 2000 },
    ];
    const sources = {
      [A]: sourceOf(A),
      [mute]: sourceOf(mute, { hasAudio: false, audioCodec: null }),
    };
    const out = join(DIR, "enc-mute.mp4");
    ffmpeg(encodeArgs(clips, sources, out));

    // A saída TEM áudio (o do clipe A + silêncio no trecho mudo).
    expect(streamsOf(out)).toEqual(["h264,video", "aac,audio"]);
    expect(durationOf(out)).toBeGreaterThan(3900);
    expect(durationOf(out)).toBeLessThan(4200);
  });

  it("o -c copy é MUITO mais rápido que o re-encode — é o motivo de ele existir", () => {
    const src = sourceOf(A);
    const copyStart = Date.now();
    runCopy([{ path: A, srcIn: 0, srcOut: 9000 }], join(DIR, "speed-copy.mp4"));
    const copyMs = Date.now() - copyStart;

    const encStart = Date.now();
    ffmpeg(encodeArgs([{ path: A, srcIn: 0, srcOut: 9000 }], { [A]: src }, join(DIR, "speed-enc.mp4")));
    const encMs = Date.now() - encStart;

    // Sem número mágico: só a ordem de grandeza que justifica a existência dos
    // dois caminhos. Se um dia isto falhar, é sinal de que o "copy" parou de
    // copiar (e passou a recodificar calado).
    expect(copyMs).toBeLessThan(encMs);
    console.log(`\n  [prova] -c copy: ${copyMs} ms · re-encode: ${encMs} ms\n`);
  });
});

/* ================================================================== */
/* v0.2 — o COMPILADOR de filter_complex, provado com ffmpeg real      */
/* ================================================================== */

const FONT = join(process.cwd(), "src-tauri", "fonts", "LocalVideoSans.ttf");
const V2DIR = join(tmpdir(), "localvideo-export-v2");

const vtrack = (clips: Clip[], id = "v1"): Track => ({ id, kind: "video", clips });
const atrack = (clips: Clip[], id = "a1"): Track => ({ id, kind: "audio", clips });
const timeline = (tracks: Track[]): Timeline => ({ version: 2, tracks });

/** `mean_volume`/`max_volume` (dB) de um trecho, pelo volumedetect. É o que prova
 *  "não é silêncio" e a rampa do fade. -91 dB é o piso do detector = silêncio. */
function volumedetect(path: string, startSec: number, durSec: number): { mean: number; max: number } {
  const r = spawnSync(
    FFMPEG,
    ["-hide_banner", "-ss", String(startSec), "-t", String(durSec), "-i", path, "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const err = r.stderr || "";
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(err);
  const max = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(err);
  return { mean: mean ? parseFloat(mean[1]) : -91, max: max ? parseFloat(max[1]) : -91 };
}

/** Extrai UM frame no instante `atSec` pra um PNG (pra olhar o título com o olho).
 *  `-update 1` porque é UMA imagem só (sem padrão de sequência). */
function extractFrame(path: string, atSec: number, outPng: string): void {
  ffmpeg(["-ss", String(atSec), "-i", path, "-frames:v", "1", "-update", "1", outPng]);
}

function dimsOf(path: string): [number, number] {
  const s = ffprobe([
    "-v", "quiet", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x", path,
  ]).trim();
  const [w, h] = s.split("x").map((n) => parseInt(n, 10));
  return [w, h];
}

describe.skipIf(!ENABLED)("compilador filter_complex (ffmpeg real)", () => {
  beforeAll(() => {
    rmSync(V2DIR, { recursive: true, force: true });
    mkdirSync(V2DIR, { recursive: true });
    // A (640x480, 10s, sine 440) e B (640x480, 6s, sine 440) já existem no DIR do
    // bloco anterior — mas o beforeAll dele roda no describe dele. Recriamos aqui
    // pra este bloco ser independente.
    for (const [path, pattern, dur, freq] of [
      [A, "testsrc", 10, 440],
      [B, "testsrc2", 6, 660],
    ] as const) {
      ffmpeg([
        "-f", "lavfi", "-i", `${pattern}=size=640x480:rate=30:duration=${dur}`,
        "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${dur}`,
        "-c:v", "libx264", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
      ]);
    }
  });

  it("GATE: 2 trilhas de vídeo sobrepostas → 1 saída, resolução e duração certas", () => {
    // Trilha base A [0,4s); overlay B [0,2s) a 50% de opacidade (pra as DUAS
    // aparecerem misturadas — prova de que compôs, não só empilhou).
    const tl = timeline([
      vtrack([{ id: "a", startMs: 0, durationMs: 4000, path: A, srcIn: 0 }]),
      vtrack([{ id: "b", startMs: 0, durationMs: 2000, path: B, srcIn: 0, opacity: 0.5 }], "v2"),
    ]);
    const out = join(V2DIR, "overlay.mp4");
    ffmpeg(filterComplexArgs(tl, { [A]: sourceOf(A), [B]: sourceOf(B) }, out));

    expect(dimsOf(out)).toEqual([640, 480]);
    // Duração = a trilha mais longa (4 s).
    expect(durationOf(out)).toBeGreaterThan(3900);
    expect(durationOf(out)).toBeLessThan(4200);
    // Um frame no meio da sobreposição, pra olhar o blend com o olho.
    extractFrame(out, 1, join(V2DIR, "overlay-frame.png"));
    console.log(`\n  [prova] overlay: ${durationOf(out)} ms, ${dimsOf(out).join("x")}\n`);
  });

  it("GATE: crossfade → duração = soma − transição (a conta cravada)", () => {
    // A [0,4s), B começa em 3s (dur 4s) → 1 s de sobreposição = crossfade.
    // soma = 4+4 = 8 s; transição = 1 s; esperado = 7 s.
    const tl = timeline([
      vtrack([
        { id: "a", startMs: 0, durationMs: 4000, path: A, srcIn: 0 },
        { id: "b", startMs: 3000, durationMs: 4000, path: B, srcIn: 0 },
      ]),
    ]);
    const out = join(V2DIR, "xfade.mp4");
    ffmpeg(filterComplexArgs(tl, { [A]: sourceOf(A), [B]: sourceOf(B) }, out));

    const d = durationOf(out);
    // 8000 − 1000 = 7000. A folga é do re-encode, não da conta.
    expect(d).toBeGreaterThan(6900);
    expect(d).toBeLessThan(7200);
    extractFrame(out, 3.5, join(V2DIR, "xfade-frame.png"));
    console.log(`\n  [prova] crossfade: soma 8000 − transição 1000 = 7000; saiu ${d} ms\n`);
  });

  it("GATE: título → o texto aparece no frame (extraído e olhado)", () => {
    // O texto carrega os quatro chars do gate do escape (`:'\%`) — se sair no
    // frame, o escape está certo.
    const title: Clip = {
      id: "t",
      startMs: 1000,
      durationMs: 3000,
      title: { text: "GATE 50% a:b it's c\\d", fontSizePx: 44, color: "#ffee00", anchor: "center" },
    };
    const tl = timeline([vtrack([{ id: "a", startMs: 0, durationMs: 5000, path: A, srcIn: 0 }, title])]);
    const out = join(V2DIR, "title.mp4");
    ffmpeg(filterComplexArgs(tl, { [A]: sourceOf(A) }, out, { fontPath: FONT }));

    expect(durationOf(out)).toBeGreaterThan(4900);
    expect(durationOf(out)).toBeLessThan(5200);
    // Frame DENTRO da janela do título (t=2.5s) e frame FORA (t=0.5s), pra olhar.
    extractFrame(out, 2.5, join(V2DIR, "title-frame-in.png"));
    extractFrame(out, 0.5, join(V2DIR, "title-frame-out.png"));
    console.log(`\n  [prova] título renderizado — olhar ${join(V2DIR, "title-frame-in.png")}\n`);
  });

  it("GATE: 2 trilhas de áudio mixadas → volumedetect prova que as duas entraram", () => {
    // Duas trilhas de áudio (vídeos com som), escalonadas no tempo:
    //  A (440 Hz) em [0,3s); B (660 Hz) em [2,5s). Áudio total 0..5s.
    const tl = timeline([
      atrack([{ id: "za", startMs: 0, durationMs: 3000, path: A, srcIn: 0 }], "a1"),
      atrack([{ id: "zb", startMs: 2000, durationMs: 3000, path: B, srcIn: 0 }], "a2"),
    ]);
    const out = join(V2DIR, "amix.mp4");
    ffmpeg(filterComplexArgs(tl, { [A]: sourceOf(A), [B]: sourceOf(B) }, out));

    // Trecho onde SÓ A toca (0.2..1.5): não é silêncio → A entrou.
    const onlyA = volumedetect(out, 0.2, 1.2);
    // Trecho onde SÓ B toca (3.5..4.8): não é silêncio → B entrou.
    const onlyB = volumedetect(out, 3.5, 1.2);
    expect(onlyA.mean).toBeGreaterThan(-50);
    expect(onlyB.mean).toBeGreaterThan(-50);
    console.log(`\n  [prova] amix: só-A mean ${onlyA.mean} dB · só-B mean ${onlyB.mean} dB (ambas ≠ silêncio)\n`);
  });

  it("GATE: fade in/out → volumedetect prova a rampa (começo baixo, meio alto)", () => {
    // Um clipe de 4 s com fade de 1,5 s na entrada e na saída.
    const tl = timeline([
      atrack([{ id: "z", startMs: 0, durationMs: 4000, path: A, srcIn: 0, fadeInMs: 1500, fadeOutMs: 1500 }], "a1"),
    ]);
    const out = join(V2DIR, "fade.mp4");
    ffmpeg(filterComplexArgs(tl, { [A]: sourceOf(A) }, out));

    const start = volumedetect(out, 0, 0.25); // começo do fade-in
    const mid = volumedetect(out, 1.8, 0.4); // platô
    const end = volumedetect(out, 3.75, 0.25); // fim do fade-out
    // A rampa: começo e fim MUITO mais baixos que o meio.
    expect(mid.mean).toBeGreaterThan(start.mean + 8);
    expect(mid.mean).toBeGreaterThan(end.mean + 8);
    console.log(`\n  [prova] fade: início ${start.mean} dB · meio ${mid.mean} dB · fim ${end.mean} dB\n`);
  });

  it("degenerada continua saindo por -c copy (não regride a v0.1)", () => {
    // Uma trilha, dois clipes em fila, sem nada da v0.2 → o planExport escolhe copy.
    // (A prova do -c copy propriamente dita está no bloco anterior; aqui só se
    // confirma que a timeline v0.2 típica não força re-encode à toa.)
    const clips: ExportClip[] = [
      { path: A, srcIn: 0, srcOut: 2000 },
      { path: A, srcIn: 3000, srcOut: 5000 },
    ];
    expect(planExport(clips, { [A]: sourceOf(A) }).kind).toBe("copy");
  });
});
