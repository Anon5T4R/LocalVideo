/**
 * v0.15 — as duas maneiras de o app dizer "não" pra quem queria CRIAR um vídeo
 * em vez de editar um que já existe.
 *
 * 1. **Imagem virava tela preta.** O portão que decide se a prévia compõe no
 *    canvas exigia que TODO arquivo fosse decodificável pelo WebCodecs, e um
 *    `.png` não é. Reprovando o portão, a composição não rodava; e imagem também
 *    não vai pro `<video>` (que não decodifica png) — então não sobrava caminho
 *    nenhum. Uma timeline feita de uma foto não mostrava nada.
 * 2. **Áudio não entrava.** Não existia extensão de áudio em lugar nenhum: o
 *    diálogo não listava mp3/wav, o drop nativo os filtrava fora em silêncio, e
 *    quem chegasse ao `probe` levava `Err("no-video")`. Montar um vídeo a partir
 *    de uma música (com foto ou título por cima) era impossível.
 *
 * Os dois defeitos moravam em código sem teste — daí este arquivo cobrir
 * exatamente as decisões puras que estavam soltas em componente/estado.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { filterComplexArgs, type SourceInfo } from "../args";
import { canDecodeLayers, layersAt, needsComposite, needsVideoDecode } from "../compose";
import { AUDIO_EXT, isAudioPath, isImagePath } from "../probe";
import { __resetIds, appendMedia, newTimeline, type Clip, type Timeline, type Track } from "../timeline";

beforeEach(() => __resetIds());

const MP4 = "C:\\v\\a.mp4";
const IMG = "C:\\v\\foto.png";
const MP3 = "C:\\v\\musica.mp3";

const vtrack = (clips: Clip[], id = "v1"): Track => ({ id, kind: "video", clips });
const atrack = (clips: Clip[], id = "a1"): Track => ({ id, kind: "audio", clips });
const tl = (tracks: Track[]): Timeline => ({ version: 4, tracks });

const imgClip = (over: Partial<Clip> = {}): Clip => ({
  id: "i", startMs: 0, durationMs: 5000, path: IMG, srcIn: 0, image: true, ...over,
});
const vidClip = (over: Partial<Clip> = {}): Clip => ({
  id: "v", startMs: 0, durationMs: 5000, path: MP4, srcIn: 0, ...over,
});
const titleClip = (over: Partial<Clip> = {}): Clip => ({
  id: "t",
  startMs: 0,
  durationMs: 3000,
  title: { text: "olá", fontSizePx: 48, color: "white", anchor: "bottom" },
  ...over,
});

/** O `canDecodeExactly` de verdade: só containers que o mp4box abre. */
const mp4Only = (path: string) => path.toLowerCase().endsWith(".mp4");

function src(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    keyframesMs: [0, 1000, 2000],
    width: 640,
    height: 480,
    fps: 30,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* 1. A prévia preta da imagem                                         */
/* ------------------------------------------------------------------ */

describe("portão da composição (o bug da prévia preta)", () => {
  it("IMAGEM passa mesmo com um decodificador que só aceita mp4", () => {
    const layers = layersAt(tl([vtrack([imgClip()])]), 1000);
    expect(layers).toHaveLength(1);
    // O teste que teria pego o bug: com a regra antiga (`canDecode(path)` pra
    // todo mundo), isto era `false` e a prévia ficava preta.
    expect(canDecodeLayers(layers, [], mp4Only)).toBe(true);
    // E a composição É necessária — imagem nunca vai pro `<video>`.
    expect(needsComposite(layers)).toBe(true);
  });

  it("vídeo em container que o demuxer não abre continua reprovando", () => {
    const mkv = vidClip({ path: "C:\\v\\a.mkv" });
    const layers = layersAt(tl([vtrack([mkv])]), 1000);
    expect(canDecodeLayers(layers, [], mp4Only)).toBe(false);
  });

  it("arquivo SUMIDO reprova, mesmo sendo imagem", () => {
    const layers = layersAt(tl([vtrack([imgClip()])]), 1000);
    expect(canDecodeLayers(layers, [IMG], mp4Only)).toBe(false);
  });

  it("imagem + vídeo: quem manda é o vídeo", () => {
    const layers = layersAt(
      tl([vtrack([imgClip()]), vtrack([vidClip({ path: "C:\\v\\b.mkv" })], "v2")]),
      1000,
    );
    expect(layers).toHaveLength(2);
    expect(canDecodeLayers(layers, [], mp4Only)).toBe(false);
  });
});

describe("compor durante o play (needsVideoDecode)", () => {
  it("só imagem e/ou título dispensa decodificar vídeo", () => {
    expect(needsVideoDecode(layersAt(tl([vtrack([imgClip()])]), 1000))).toBe(false);
    expect(needsVideoDecode(layersAt(tl([vtrack([titleClip()])]), 1000))).toBe(false);
    expect(
      needsVideoDecode(layersAt(tl([vtrack([imgClip()]), vtrack([titleClip()], "v2")]), 1000)),
    ).toBe(false);
  });

  it("qualquer vídeo na tela volta a exigir o <video>", () => {
    expect(needsVideoDecode(layersAt(tl([vtrack([vidClip()])]), 1000))).toBe(true);
    expect(
      needsVideoDecode(layersAt(tl([vtrack([imgClip()]), vtrack([vidClip()], "v2")]), 1000)),
    ).toBe(true);
  });

  it("nada na tela não pede decodificação nenhuma", () => {
    expect(needsVideoDecode([])).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Áudio como fonte                                                 */
/* ------------------------------------------------------------------ */

describe("reconhecer arquivo só-áudio", () => {
  it("as extensões comuns entram, e sem confundir com imagem", () => {
    for (const ext of ["mp3", "wav", "flac", "m4a", "opus", "ogg"]) {
      expect(isAudioPath(`C:\\x\\y.${ext}`)).toBe(true);
      expect(isImagePath(`C:\\x\\y.${ext}`)).toBe(false);
    }
    expect(isAudioPath(MP4)).toBe(false);
    expect(isAudioPath(IMG)).toBe(false);
    // Maiúscula não muda nada (o Explorer do Windows entrega assim).
    expect(isAudioPath("C:\\x\\Y.MP3")).toBe(true);
    // Container de VÍDEO não vira áudio nem quando só tem som: quem separa é o
    // usuário, com o "separar áudio" que já existe.
    expect(AUDIO_EXT).not.toContain("mp4");
    expect(AUDIO_EXT).not.toContain("mkv");
  });
});

describe("appendMedia roteia áudio pra trilha de áudio", () => {
  it("mp3 NÃO entra na base de vídeo (senão viraria um trecho preto)", () => {
    const out = appendMedia(newTimeline(), {
      path: MP3, srcIn: 0, srcOut: 180_000, audio: true,
    });
    const [video, audio] = out.tracks;
    expect(video.kind).toBe("video");
    expect(video.clips).toHaveLength(0);
    expect(audio.clips).toHaveLength(1);
    expect(audio.clips[0].path).toBe(MP3);
    expect(audio.clips[0].durationMs).toBe(180_000);
  });

  it("sem trilha de áudio (dá pra removê-la), CRIA uma em vez de sumir com o import", () => {
    const semAudio: Timeline = tl([vtrack([])]);
    const out = appendMedia(semAudio, { path: MP3, srcIn: 0, srcOut: 5000, audio: true });
    expect(out.tracks).toHaveLength(2);
    expect(out.tracks[1].kind).toBe("audio");
    expect(out.tracks[1].clips[0].path).toBe(MP3);
  });

  it("o segundo áudio enfileira DEPOIS do primeiro, sem buraco", () => {
    let out = appendMedia(newTimeline(), { path: MP3, srcIn: 0, srcOut: 4000, audio: true });
    out = appendMedia(out, { path: "C:\\v\\voz.wav", srcIn: 0, srcOut: 2000, audio: true });
    const audio = out.tracks.find((t) => t.kind === "audio")!;
    expect(audio.clips.map((c) => [c.startMs, c.durationMs])).toEqual([
      [0, 4000],
      [4000, 2000],
    ]);
  });

  it("vídeo segue indo pra base (o roteamento não mexeu no caminho antigo)", () => {
    const out = appendMedia(newTimeline(), { path: MP4, srcIn: 0, srcOut: 3000 });
    expect(out.tracks[0].clips).toHaveLength(1);
    expect(out.tracks[1].clips).toHaveLength(0);
  });
});

describe("export de foto + música", () => {
  const sources = { [IMG]: src({ width: 1080, height: 1080, hasAudio: false }), [MP3]: src({ width: 0, height: 0, fps: 0, videoCodec: "" }) };

  it("gera vídeo E áudio: `-loop 1 -t` na foto e a música mixada por cima", () => {
    const t = tl([
      vtrack([imgClip({ durationMs: 10_000 })]),
      atrack([{ id: "m", startMs: 0, durationMs: 10_000, path: MP3, srcIn: 0 }]),
    ]);
    const args = filterComplexArgs(t, sources, "out.mp4");
    // A foto vira stream infinito limitado pela duração do clipe.
    expect(args.join(" ")).toContain(`-loop 1 -t 10.000 -i ${IMG}`);
    // E as duas pontas são MAPEADAS: sem `-map` de áudio o vídeo sairia mudo.
    expect(args).toContain("-c:v");
    expect(args).toContain("-c:a");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("adelay=0|0");
  });

  it("resolução vinda de FOTO é forçada a lado PAR (o libx264 recusa ímpar)", () => {
    const odd = { [IMG]: src({ width: 1919, height: 1079, hasAudio: false }) };
    const args = filterComplexArgs(tl([vtrack([imgClip()])]), odd, "out.mp4");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("1918x1078");
    expect(fc).not.toContain("1919");
  });
});
