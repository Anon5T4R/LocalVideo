import { describe, expect, it } from "vitest";

import {
  concatArgs,
  concatListBody,
  degenerateClips,
  drawtextEscape,
  encodeArgs,
  filterComplexArgs,
  keyframeProbeArgs,
  nearestKeyframe,
  parseKeyframesCsv,
  planExport,
  secs,
  type ExportClip,
  type SourceInfo,
} from "../args";
import type { Clip, Timeline, Track } from "../timeline";

/** Um fonte de mentira, com quadro-chave a cada 1 s (o `-g 30` a 30 fps). */
function src(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    keyframesMs: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000],
    width: 640,
    height: 480,
    fps: 30,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    ...over,
  };
}

const A = "C:\\v\\a.mp4";
const B = "C:\\v\\b.mp4";

describe("parseKeyframesCsv", () => {
  it("lê a saída LITERAL do ffprobe — inclusive a vírgula sobrando do 1º quadro", () => {
    // Copiado da saída real do ffprobe n-125648 no vídeo de teste (`-g 30`,
    // 30 fps, 10 s). Repare no `frame,0.000000,` — a vírgula a mais é de
    // verdade, e é justo no quadro-chave do zero.
    const real = [
      "frame,0.000000,",
      "frame,1.000000",
      "frame,2.000000",
      "frame,3.000000",
      "frame,4.000000",
      "frame,5.000000",
      "frame,6.000000",
      "frame,7.000000",
      "frame,8.000000",
      "frame,9.000000",
      "",
    ].join("\n");
    // O 0 TEM que estar aqui: sem ele, um clipe inteiro (srcIn=0) seria
    // recodificado à toa — o oposto do que o app promete.
    expect(parseKeyframesCsv(real)).toEqual([
      0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000,
    ]);
  });

  it("joga fora N/A, lixo e negativo — nada de NaN entrando na lista", () => {
    // Um NaN na lista envenena a busca binária (toda comparação vira false) e o
    // app passaria a escolher o caminho do export no escuro.
    const csv = "frame,0.000000\nframe,N/A\nframe,\nframe,abc\nframe,-1.0\nframe,2.500000\n";
    expect(parseKeyframesCsv(csv)).toEqual([0, 2500]);
  });

  it("ordena e deduplica (container remuxado repete pts)", () => {
    expect(parseKeyframesCsv("frame,2.0\nframe,0.0\nframe,2.0\nframe,1.0")).toEqual([0, 1000, 2000]);
  });

  it("csv vazio é lista vazia, não explosão", () => {
    expect(parseKeyframesCsv("")).toEqual([]);
    expect(parseKeyframesCsv("\n\n")).toEqual([]);
  });
});

describe("nearestKeyframe", () => {
  const kf = [0, 1000, 2000, 3000];
  it("acha o mais perto dos dois lados", () => {
    expect(nearestKeyframe(kf, 0)).toBe(0);
    expect(nearestKeyframe(kf, 1100)).toBe(1000);
    expect(nearestKeyframe(kf, 1900)).toBe(2000);
    expect(nearestKeyframe(kf, 3000)).toBe(3000);
  });
  it("fora das pontas gruda na ponta", () => {
    expect(nearestKeyframe(kf, -500)).toBe(0);
    expect(nearestKeyframe(kf, 99999)).toBe(3000);
  });
  it("empate vai pro anterior (é pra onde o ffmpeg escorregaria)", () => {
    expect(nearestKeyframe(kf, 1500)).toBe(1000);
  });
  it("sem lista, sem resposta — e sem chute", () => {
    expect(nearestKeyframe([], 10)).toBe(null);
  });
  it("busca binária bate com a varredura burra, em lista grande", () => {
    // Blindagem contra o clássico erro de ±1 do binary search.
    const big = Array.from({ length: 500 }, (_, i) => i * 333);
    for (let t = 0; t < 166000; t += 97) {
      const dumb = big.reduce((b, k) => (Math.abs(k - t) < Math.abs(b - t) ? k : b), big[0]);
      expect(nearestKeyframe(big, t)).toBe(dumb);
    }
  });
});

describe("planExport — a decisão que faz o app parecer rápido", () => {
  it("clipe inteiro (srcIn=0) → copy: o 0 é sempre quadro-chave", () => {
    const clips: ExportClip[] = [{ path: A, srcIn: 0, srcOut: 10000 }];
    const p = planExport(clips, { [A]: src() });
    expect(p.kind).toBe("copy");
    expect(p.reason.code).toBe("copy-exact");
  });

  it("corte EM quadro-chave → copy", () => {
    const clips: ExportClip[] = [{ path: A, srcIn: 3000, srcOut: 6000 }];
    expect(planExport(clips, { [A]: src() }).kind).toBe("copy");
  });

  it("aparar só o FIM → copy: o fim não precisa de quadro-chave", () => {
    // Isto é metade dos cortes reais (tirar o rabo de uma gravação). Exigir
    // quadro-chave no fim recodificaria tudo isso à toa.
    const clips: ExportClip[] = [{ path: A, srcIn: 0, srcOut: 4321 }];
    expect(planExport(clips, { [A]: src() }).kind).toBe("copy");
  });

  it("corte FORA de quadro-chave → encode, e diz ONDE e qual era o vizinho", () => {
    const clips: ExportClip[] = [{ path: A, srcIn: 4300, srcOut: 6000 }];
    const p = planExport(clips, { [A]: src() });
    expect(p.kind).toBe("encode");
    expect(p.reason).toEqual({ code: "encode-off-keyframe", atMs: 4300, nearestMs: 4000, path: A });
  });

  it("meio quadro de diferença é o MESMO quadro → copy sem alarde", () => {
    // 30 fps ⇒ tolerância de ~16,7 ms. 10 ms de diferença é arredondamento de
    // ms, não um corte em outro lugar.
    const clips: ExportClip[] = [{ path: A, srcIn: 3010, srcOut: 6000 }];
    const p = planExport(clips, { [A]: src() });
    expect(p.kind).toBe("copy");
    expect(p.reason.code).toBe("copy-exact");
    expect(p.clips[0].srcIn).toBe(3000);
  });

  it("encostar é OPCIONAL: sem pedir, não mexe no corte de ninguém", () => {
    const clips: ExportClip[] = [{ path: A, srcIn: 3200, srcOut: 6000 }];
    expect(planExport(clips, { [A]: src() }).kind).toBe("encode");
  });

  it("com snap ligado → copy, e conta o desvio real", () => {
    const clips: ExportClip[] = [{ path: A, srcIn: 3200, srcOut: 6000 }];
    const p = planExport(clips, { [A]: src() }, { snap: true });
    expect(p.kind).toBe("copy");
    expect(p.reason).toEqual({ code: "copy-snapped", maxShiftMs: 200 });
    // Encostou o começo…
    expect(p.clips[0].srcIn).toBe(3000);
    // …e NÃO mexeu no fim (o usuário aparou aquele fim de propósito).
    expect(p.clips[0].srcOut).toBe(6000);
  });

  it("snap não vale pra desvio grande — isso seria outro corte", () => {
    const clips: ExportClip[] = [{ path: A, srcIn: 3600, srcOut: 6000 }];
    expect(planExport(clips, { [A]: src() }, { snap: true, snapToleranceMs: 100 }).kind).toBe(
      "encode",
    );
  });

  it("basta UM corte ruim pra derrubar o filme inteiro no re-encode", () => {
    // O concat demuxer é tudo-ou-nada: não dá pra copiar metade.
    const clips: ExportClip[] = [
      { path: A, srcIn: 0, srcOut: 1000 },
      { path: A, srcIn: 4300, srcOut: 5000 },
    ];
    const p = planExport(clips, { [A]: src() });
    expect(p.kind).toBe("encode");
    expect(p.reason.code).toBe("encode-off-keyframe");
  });

  it("dois arquivos compatíveis, cortes em quadro-chave → copy", () => {
    const clips: ExportClip[] = [
      { path: A, srcIn: 0, srcOut: 2000 },
      { path: B, srcIn: 1000, srcOut: 3000 },
    ];
    expect(planExport(clips, { [A]: src(), [B]: src() }).kind).toBe("copy");
  });

  it("formatos diferentes → encode (o concat demuxer cola pacote, não converte)", () => {
    const clips: ExportClip[] = [
      { path: A, srcIn: 0, srcOut: 2000 },
      { path: B, srcIn: 0, srcOut: 2000 },
    ];
    expect(planExport(clips, { [A]: src(), [B]: src({ width: 1920, height: 1080 }) }).reason.code).toBe(
      "encode-mixed-format",
    );
    expect(planExport(clips, { [A]: src(), [B]: src({ videoCodec: "hevc" }) }).reason.code).toBe(
      "encode-mixed-format",
    );
    // Um com áudio e outro mudo também não colam.
    expect(
      planExport(clips, { [A]: src(), [B]: src({ hasAudio: false, audioCodec: null }) }).reason.code,
    ).toBe("encode-mixed-format");
  });

  it("UM clipe só nunca é 'formato misturado' — não há com o que misturar", () => {
    const clips: ExportClip[] = [{ path: B, srcIn: 0, srcOut: 2000 }];
    expect(planExport(clips, { [B]: src({ width: 1920, height: 1080 }) }).kind).toBe("copy");
  });

  it("sem sonda de quadro-chave → encode: não se chuta o caminho", () => {
    const clips: ExportClip[] = [{ path: A, srcIn: 0, srcOut: 1000 }];
    const p = planExport(clips, { [A]: src({ keyframesMs: [] }) });
    expect(p.kind).toBe("encode");
    expect(p.reason).toEqual({ code: "encode-no-keyframe-data", path: A });
    // Fonte que nem existe no mapa também não vira chute.
    expect(planExport(clips, {}).reason.code).toBe("encode-no-keyframe-data");
  });

  it("encostar não pode criar clipe vazio", () => {
    // Corte curtinho logo antes de um quadro-chave: encostar pra frente comeria
    // o clipe todo. Melhor recodificar do que sumir com o trecho.
    const clips: ExportClip[] = [{ path: A, srcIn: 2900, srcOut: 2950 }];
    const p = planExport(clips, { [A]: src() }, { snap: true });
    expect(p.kind).toBe("encode");
  });

  it("planExport não modifica os clipes que recebeu", () => {
    const clips: ExportClip[] = [{ path: A, srcIn: 3200, srcOut: 6000 }];
    planExport(clips, { [A]: src() }, { snap: true });
    expect(clips[0].srcIn).toBe(3200);
  });
});

describe("montagem dos args", () => {
  it("secs: ms viram segundos com 3 casas", () => {
    expect(secs(0)).toBe("0.000");
    expect(secs(1500)).toBe("1.500");
    expect(secs(90061000)).toBe("90061.000");
    expect(secs(-5)).toBe("0.000");
  });

  it("concatListBody: cada trecho vira file + inpoint + outpoint", () => {
    // Os cortes vão DENTRO da lista: um ffmpeg só, sem trecho temporário, e o
    // vídeo escrito uma vez em vez de duas.
    const body = concatListBody([
      { path: "C:\\v\\a.mp4", srcIn: 0, srcOut: 2000 },
      { path: "C:\\v\\a.mp4", srcIn: 5000, srcOut: 8000 },
    ]);
    expect(body).toBe(
      [
        "file 'C:/v/a.mp4'",
        "inpoint 0.000",
        "outpoint 2.000",
        "file 'C:/v/a.mp4'",
        "inpoint 5.000",
        "outpoint 8.000",
        "",
      ].join("\n"),
    );
  });

  it("concatListBody: escapa aspa simples como o demuxer exige", () => {
    // `it's.mp4` sem escape fecha a aspa no meio do caminho, e o ffmpeg vai
    // procurar um arquivo que ninguém pediu. Dentro de aspas simples, a única
    // saída é `'\''`. (A mesma lição que o LocalMedia já pagou.)
    const body = concatListBody([{ path: "C:\\vídeos\\it's.mp4", srcIn: 0, srcOut: 1000 }]);
    expect(body.split("\n")[0]).toBe("file 'C:/vídeos/it'\\''s.mp4'");
  });

  it("concatListBody: contrabarra do Windows vira barra (o demuxer trata \\ como escape)", () => {
    const body = concatListBody([{ path: "C:\\v\\sub\\a.mp4", srcIn: 0, srcOut: 1 }]);
    expect(body).toContain("file 'C:/v/sub/a.mp4'");
    expect(body).not.toContain("\\");
  });

  it("concatArgs: -safe 0 porque a lista tem caminho absoluto", () => {
    expect(concatArgs("C:\\t\\list.txt", "C:\\out.mp4", true)).toEqual([
      "-f", "concat", "-safe", "0", "-i", "C:\\t\\list.txt",
      "-map", "0:v:0", "-map", "0:a:0",
      "-c", "copy", "-avoid_negative_ts", "make_zero", "C:\\out.mp4",
    ]);
  });

  it("concatArgs: filme mudo sai com -an, não com um -map de áudio que não existe", () => {
    const a = concatArgs("l.txt", "o.mp4", false);
    expect(a).toContain("-an");
    expect(a).not.toContain("0:a:0");
  });

  it("keyframeProbeArgs: -skip_frame nokey é o que torna a sonda viável", () => {
    const a = keyframeProbeArgs(A);
    expect(a).toContain("-skip_frame");
    expect(a[a.indexOf("-skip_frame") + 1]).toBe("nokey");
    expect(a).toContain("v:0");
    expect(a[a.length - 1]).toBe(A);
  });
});

describe("encodeArgs — o grafo do filter_complex", () => {
  it("um clipe: trim no tempo do fonte + rebobinada pro zero", () => {
    const a = encodeArgs([{ path: A, srcIn: 1500, srcOut: 4500 }], { [A]: src() }, "C:\\out.mp4");
    const fc = a[a.indexOf("-filter_complex") + 1];
    expect(fc).toContain("trim=start=1.500:end=4.500");
    // Sem o setpts o trecho "começa" aos 1,5 s e o filme sai com buraco.
    expect(fc).toContain("setpts=PTS-STARTPTS");
    expect(fc).toContain("atrim=start=1.500:end=4.500");
    expect(fc).toContain("concat=n=1:v=1:a=1[outv][outa]");
    expect(a).toContain("libx264");
    expect(a[a.length - 1]).toBe("C:\\out.mp4");
  });

  it("dois clipes: uma entrada por clipe, na ordem, e concat n=2", () => {
    const a = encodeArgs(
      [
        { path: A, srcIn: 0, srcOut: 1000 },
        { path: B, srcIn: 2000, srcOut: 3000 },
      ],
      { [A]: src(), [B]: src() },
      "o.mp4",
    );
    expect(a.slice(0, 4)).toEqual(["-i", A, "-i", B]);
    const fc = a[a.indexOf("-filter_complex") + 1];
    expect(fc).toContain("[0:v:0]");
    expect(fc).toContain("[1:v:0]");
    expect(fc).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]");
  });

  it("mesmo arquivo duas vezes vira duas entradas (grafo legível > grafo esperto)", () => {
    const a = encodeArgs(
      [
        { path: A, srcIn: 0, srcOut: 1000 },
        { path: A, srcIn: 5000, srcOut: 6000 },
      ],
      { [A]: src() },
      "o.mp4",
    );
    expect(a.slice(0, 4)).toEqual(["-i", A, "-i", A]);
  });

  it("todo mundo mudo → saída sem trilha de áudio (a=0), sem -c:a solto", () => {
    const s = src({ hasAudio: false, audioCodec: null });
    const a = encodeArgs([{ path: A, srcIn: 0, srcOut: 1000 }], { [A]: s }, "o.mp4");
    const fc = a[a.indexOf("-filter_complex") + 1];
    expect(fc).toContain("concat=n=1:v=1:a=0[outv]");
    expect(fc).not.toContain("[outa]");
    expect(a).not.toContain("-c:a");
    expect(a).not.toContain("anullsrc");
  });

  it("MISTURA de mudo com sonoro: silêncio no lugar do que falta", () => {
    // O concat (filtro) recusa colar trechos com contagem de trilhas diferente.
    // Sem o anullsrc, um clipe mudo no meio custaria o áudio do filme inteiro.
    const a = encodeArgs(
      [
        { path: A, srcIn: 0, srcOut: 1000 },
        { path: B, srcIn: 0, srcOut: 2000 },
      ],
      { [A]: src(), [B]: src({ hasAudio: false, audioCodec: null }) },
      "o.mp4",
    );
    expect(a).toContain("anullsrc=channel_layout=stereo:sample_rate=48000");
    // A duração do silêncio bate com a do clipe mudo.
    expect(a[a.indexOf("anullsrc=channel_layout=stereo:sample_rate=48000") - 2]).toBe("2.000");
    const fc = a[a.indexOf("-filter_complex") + 1];
    // O silêncio é a entrada 2 (depois dos 2 clipes) e vira o áudio do clipe 1.
    expect(fc).toContain("[2:a:0]");
    expect(fc).toContain("concat=n=2:v=1:a=1[outv][outa]");
    // No clipe mudo não há o que aparar — atrim num anullsrc de duração certa
    // seria redundante.
    expect(fc).not.toContain("[2:a:0]atrim");
  });

  it("tamanhos diferentes: cabe inteiro com barra, nunca esticado", () => {
    const a = encodeArgs(
      [
        { path: A, srcIn: 0, srcOut: 1000 },
        { path: B, srcIn: 0, srcOut: 1000 },
      ],
      { [A]: src(), [B]: src({ width: 1920, height: 1080 }) },
      "o.mp4",
    );
    const fc = a[a.indexOf("-filter_complex") + 1];
    // O alvo é a geometria do PRIMEIRO clipe (é "o vídeo" pro usuário).
    expect(fc).toContain("scale=640:480:force_original_aspect_ratio=decrease");
    expect(fc).toContain("pad=640:480:(ow-iw)/2:(oh-ih)/2");
    // Quem já está no tamanho certo não passa por scale à toa.
    expect(fc.split("scale=640:480").length - 1).toBe(1);
  });

  it("fps do alvo é o MAIOR (baixar joga quadro fora de vez)", () => {
    const a = encodeArgs(
      [
        { path: A, srcIn: 0, srcOut: 1000 },
        { path: B, srcIn: 0, srcOut: 1000 },
      ],
      { [A]: src({ fps: 25 }), [B]: src({ fps: 50 }) },
      "o.mp4",
    );
    const fc = a[a.indexOf("-filter_complex") + 1];
    expect(fc).toContain("fps=50");
    expect(fc).not.toContain("fps=25");
  });

  it("saída pronta pra mandar pra alguém: yuv420p + faststart", () => {
    const a = encodeArgs([{ path: A, srcIn: 0, srcOut: 1000 }], { [A]: src() }, "o.mp4");
    // Sem yuv420p, o x264 pode sair em 4:4:4 e o vídeo não abre em player nenhum.
    expect(a[a.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(a[a.indexOf("-movflags") + 1]).toBe("+faststart");
  });
});

/* ================================================================== */
/* v0.2 — o compilador de filter_complex                               */
/* ================================================================== */

const mediaClip = (id: string, startMs: number, durationMs: number, srcIn = 0, path = A): Clip => ({
  id,
  startMs,
  durationMs,
  path,
  srcIn,
});
const vtrack = (clips: Clip[], id = "v1"): Track => ({ id, kind: "video", clips });
const atrack = (clips: Clip[], id = "a1"): Track => ({ id, kind: "audio", clips });
const tl = (tracks: Track[]): Timeline => ({ version: 2, tracks });

/** O `-filter_complex` inteiro como string (é onde mora o risco). */
function fc(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1];
}

describe("drawtextEscape — o bug clássico do drawtext (provado com ffmpeg real)", () => {
  it("cada especial ganha as barras que o render EXIGIU", () => {
    // Provados um a um com ffmpeg de verdade (ver export.real.test.ts):
    expect(drawtextEscape("%")).toBe(String.raw`\\%`); // porcento chega como \%
    expect(drawtextEscape(":")).toBe(String.raw`\:`); // sobrevive ao parser de opções
    expect(drawtextEscape("'")).toBe(String.raw`'\\\''`); // fecha aspa, escapa, reabre
    expect(drawtextEscape("\\")).toBe(String.raw`\\`); // barra literal chega como \
    expect(drawtextEscape("50%")).toBe(String.raw`50\\%`);
  });
});

describe("degenerateClips — preserva o -c copy instantâneo da v0.1", () => {
  it("1 trilha, em fila, sem nada da v0.2 → clipes pro planExport", () => {
    const t = tl([vtrack([mediaClip("a", 0, 2000), mediaClip("b", 2000, 3000, 5000)]), atrack([])]);
    expect(degenerateClips(t)).toEqual([
      { path: A, srcIn: 0, srcOut: 2000 },
      { path: A, srcIn: 5000, srcOut: 8000 },
    ]);
  });

  it("buraco entre clipes → NÃO é degenerada (precisa de preto)", () => {
    const t = tl([vtrack([mediaClip("a", 0, 2000), mediaClip("b", 3000, 1000)])]);
    expect(degenerateClips(t)).toBeNull();
  });

  it("sobreposição (transição) → NÃO é degenerada", () => {
    const t = tl([vtrack([mediaClip("a", 0, 2000), mediaClip("b", 1500, 2000)])]);
    expect(degenerateClips(t)).toBeNull();
  });

  it("2ª trilha com conteúdo, título, volume, fade, mudo → NÃO é degenerada", () => {
    expect(degenerateClips(tl([vtrack([mediaClip("a", 0, 1000)]), vtrack([mediaClip("b", 0, 1000)], "v2")]))).toBeNull();
    const withTitle: Clip = { id: "t", startMs: 0, durationMs: 1000, title: { text: "x", fontSizePx: 40, color: "#fff", anchor: "top" } };
    expect(degenerateClips(tl([vtrack([withTitle])]))).toBeNull();
    expect(degenerateClips(tl([vtrack([{ ...mediaClip("a", 0, 1000), volume: 0.5 }])]))).toBeNull();
    expect(degenerateClips(tl([vtrack([{ ...mediaClip("a", 0, 1000), fadeInMs: 200 }])]))).toBeNull();
    expect(degenerateClips(tl([vtrack([{ ...mediaClip("a", 0, 1000), muted: true }])]))).toBeNull();
  });
});

describe("filterComplexArgs — o compilador", () => {
  it("2 trilhas de vídeo → fundo preto + dois overlays + map [outv]", () => {
    const t = tl([
      vtrack([mediaClip("a", 0, 4000, 0, A)]),
      vtrack([mediaClip("b", 0, 2000, 0, B)], "v2"),
    ]);
    const a = filterComplexArgs(t, { [A]: src(), [B]: src() }, "o.mp4");
    const g = fc(a);
    // Fundo do tamanho do filme (4 s = a trilha mais longa).
    expect(g).toContain("color=c=black:s=640x480:r=30:d=4.000[vbase]");
    // Dois clipes entram por overlay ligados na janela de cada um.
    expect(g).toContain("overlay=x=0:y=0:eof_action=pass:enable='between(t,0.000,4.000)'");
    expect(g).toContain("overlay=x=0:y=0:eof_action=pass:enable='between(t,0.000,2.000)'");
    expect(a).toContain("-map");
    // Uma entrada -i por clipe de mídia.
    expect(a.slice(0, 4)).toEqual(["-i", A, "-i", B]);
  });

  it("crossfade (sobreposição) → o clipe de cima entra com fade no alfa", () => {
    // a=[0,3000), b começa em 2000 → 1000 ms de sobreposição.
    const t = tl([vtrack([mediaClip("a", 0, 3000, 0, A), mediaClip("b", 2000, 3000, 0, B)])]);
    const g = fc(filterComplexArgs(t, { [A]: src(), [B]: src() }, "o.mp4"));
    expect(g).toContain("format=yuva420p");
    expect(g).toContain("fade=t=in:st=0:d=1.000:alpha=1");
  });

  it("posiciona o clipe no tempo (setpts + adelay no áudio)", () => {
    const t = tl([vtrack([mediaClip("a", 2000, 1000, 500, A)])]);
    const g = fc(filterComplexArgs(t, { [A]: src() }, "o.mp4"));
    // Vídeo deslocado pro startMs.
    expect(g).toContain("setpts=PTS+2.000/TB");
    // Recorte no tempo do ARQUIVO (srcIn 500 → srcOut 1500).
    expect(g).toContain("trim=start=0.500:end=1.500");
    // Áudio atrasado pro startMs.
    expect(g).toContain("adelay=2000|2000");
  });

  it("título → drawtext com texto escapado, fontfile e enable na janela", () => {
    const title: Clip = {
      id: "t",
      startMs: 1000,
      durationMs: 2000,
      title: { text: "Olá: 50%", fontSizePx: 60, color: "#ffcc00", anchor: "bottom" },
    };
    const t = tl([vtrack([mediaClip("a", 0, 5000, 0, A), title])]);
    const g = fc(filterComplexArgs(t, { [A]: src() }, "o.mp4", { fontPath: "C:\\f\\font.ttf" }));
    expect(g).toContain("drawtext=");
    // Windows: o `:` do `C:` escapado como `\:` dentro das aspas.
    expect(g).toContain("fontfile='C\\:/f/font.ttf'");
    // O `%` chega ao drawtext como `\%` (⇒ `\\%`); o `:` como `\:`.
    expect(g).toContain(String.raw`text='Olá\: 50\\%'`);
    expect(g).toContain("fontsize=60");
    expect(g).toContain("enable='between(t,1.000,3.000)'");
  });

  it("2 fluxos de áudio → amix inputs=2, sem silêncio", () => {
    const t = tl([
      vtrack([mediaClip("a", 0, 3000, 0, A)]),
      atrack([mediaClip("z", 0, 3000, 0, B)]),
    ]);
    const g = fc(filterComplexArgs(t, { [A]: src(), [B]: src() }, "o.mp4"));
    expect(g).toContain("amix=inputs=2:normalize=0[outa]");
    const a = filterComplexArgs(t, { [A]: src(), [B]: src() }, "o.mp4");
    expect(a).toContain("[outa]");
  });

  it("um fluxo de áudio só → anull, sem amix à toa", () => {
    const t = tl([vtrack([mediaClip("a", 0, 2000, 0, A)])]);
    const g = fc(filterComplexArgs(t, { [A]: src() }, "o.mp4"));
    expect(g).toContain("anull[outa]");
    expect(g).not.toContain("amix");
  });

  it("volume e fade viram volume=/afade=", () => {
    const t = tl([vtrack([{ ...mediaClip("a", 0, 4000, 0, A), volume: 0.5, fadeInMs: 500, fadeOutMs: 1000 }])]);
    const g = fc(filterComplexArgs(t, { [A]: src() }, "o.mp4"));
    expect(g).toContain("volume=0.5");
    expect(g).toContain("afade=t=in:st=0:d=0.500");
    expect(g).toContain("afade=t=out:st=3.000:d=1.000");
  });

  it("clipe mudo não entra no áudio (nem vira fluxo)", () => {
    const t = tl([vtrack([{ ...mediaClip("a", 0, 2000, 0, A), muted: true }])]);
    const a = filterComplexArgs(t, { [A]: src() }, "o.mp4");
    // Sem trilha de áudio na saída.
    expect(a).not.toContain("-c:a");
    expect(fc(a)).not.toContain("[outa]");
  });

  it("saída pronta: libx264 + yuv420p + faststart", () => {
    const t = tl([vtrack([mediaClip("a", 0, 2000, 0, A)])]);
    const a = filterComplexArgs(t, { [A]: src() }, "o.mp4");
    expect(a).toContain("libx264");
    expect(a[a.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(a[a.indexOf("-movflags") + 1]).toBe("+faststart");
    expect(a[a.length - 1]).toBe("o.mp4");
  });
});
