import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  concatArgs,
  concatListBody,
  encodeArgs,
  keyframeProbeArgs,
  parseKeyframesCsv,
  planExport,
  type ExportClip,
  type SourceInfo,
} from "../args";

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
