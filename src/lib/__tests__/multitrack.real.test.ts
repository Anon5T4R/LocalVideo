import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { filterComplexArgs, keyframeProbeArgs, parseKeyframesCsv, type SourceInfo } from "../args";
import { parseSubtitles, subtitleExtractArgs } from "../subtitles";
import {
  addSubtitles,
  appendMedia,
  baseVideoTrack,
  detachAudio,
  isTitle,
  newTimeline,
  type Clip,
  type Timeline,
  type Track,
} from "../timeline";

/**
 * O portão de VERDADE do multi-faixa e das legendas embutidas: fabrica um
 * arquivo com DUAS faixas de áudio nomeadas — cada uma com um TOM diferente
 * (440 Hz no "Microfone", 880 Hz no "Áudio do sistema") — e uma legenda
 * embutida, e prova com o binário real que:
 *
 *  1. o ffprobe (com os MESMOS args do `media::probe` do Rust) devolve as duas
 *     faixas COM os títulos e a legenda — ou seja, os fixtures dos testes de
 *     `media.rs` batem com a realidade;
 *  2. `detachAudio` separa em dois clipes `audioStreamIndex` 0/1, e o EXPORT de
 *     cada clipe contém o TOM da faixa certa (medido por contagem de
 *     cruzamentos de zero no PCM decodificado — 440 vs 880 não têm como se
 *     confundir);
 *  3. `subtitleExtractArgs` extrai a legenda embutida (subrip do MKV e mov_text
 *     do MP4) num SRT que o `parseSubtitles` de sempre entende, e os cues viram
 *     clipes de título;
 *  4. o remux MKV→MP4 do LocalRecord (`-map 0 -c copy`, os args LITERAIS do
 *     `buildRemuxArgs` de lá) PRESERVA as duas faixas mas o muxer MP4 DESCARTA
 *     os títulos — é a medição que decide "culpa do Record ou do Video".
 *
 * Mesmo contrato do `export.real.test.ts`: fora do `npm test` (skipIf), pede o
 * ffmpeg de `scripts/fetch-ffmpeg` e `LOCALVIDEO_FFMPEG_TESTS=1`.
 */

const FF_DIR = join(process.cwd(), "src-tauri", "binaries", "ffmpeg");
const EXE = process.platform === "win32" ? ".exe" : "";
const FFMPEG = join(FF_DIR, `ffmpeg${EXE}`);
const FFPROBE = join(FF_DIR, `ffprobe${EXE}`);

const ENABLED = !!process.env.LOCALVIDEO_FFMPEG_TESTS && existsSync(FFMPEG);

const DIR = join(tmpdir(), "localvideo-multitrack-real");
const SRT = join(DIR, "subs.srt");
const MKV = join(DIR, "take.mkv"); // vídeo + 2 áudios nomeados + legenda subrip
const MP4 = join(DIR, "take.mp4"); // idem, mov_text + handler_name de propósito
const REC = join(DIR, "rec.mkv"); // o take "do LocalRecord": sem legenda

const MIC = "Microfone";
const SYS = "Áudio do sistema";
const FREQ_MIC = 440;
const FREQ_SYS = 880;

function ffmpeg(args: string[]): void {
  execFileSync(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...args], {
    stdio: "pipe",
  });
}

/** O ffprobe com os MESMOS args do `media::probe` (media.rs) — o JSON daqui é
 *  o JSON que o `info_from_probe_json` recebe em produção. */
function probeJson(path: string): {
  streams: {
    codec_type: string;
    codec_name: string;
    tags?: Record<string, string>;
  }[];
} {
  const out = execFileSync(
    FFPROBE,
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

function sourceOf(path: string): SourceInfo {
  const csv = execFileSync(FFPROBE, keyframeProbeArgs(path), { encoding: "utf8" });
  return {
    keyframesMs: parseKeyframesCsv(csv),
    width: 320,
    height: 240,
    fps: 30,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
  };
}

/**
 * A frequência DOMINANTE de um trecho de áudio, por contagem de cruzamentos de
 * zero no PCM decodificado (mono, 8 kHz, s16le no stdout — sem arquivo
 * temporário). Um seno puro cruza o zero 2× por ciclo, então
 * `freq = cruzamentos / 2 / segundos`. Pra distinguir 440 de 880 é régua de
 * sobra — e não depende de FFT nem de lib nenhuma.
 */
function dominantFreq(path: string, startSec: number, durSec: number): number {
  const r = spawnSync(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-ss", String(startSec), "-t", String(durSec),
     "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const buf = r.stdout;
  const n = Math.floor(buf.length / 2);
  if (n < 2) return -1;
  let crossings = 0;
  let prev = buf.readInt16LE(0);
  for (let i = 1; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) crossings++;
    prev = v;
  }
  return crossings / 2 / (n / 8000);
}

const atrack = (clips: Clip[], id = "a1"): Track => ({ id, kind: "audio", clips });
const timeline = (tracks: Track[]): Timeline => ({ version: 2, tracks });

describe.skipIf(!ENABLED)("multi-faixa e legendas embutidas (ffmpeg real)", () => {
  beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });

    // A legenda-fonte: 2 cues com tempos e textos conhecidos (com acento, que é
    // onde codificação quebra primeiro).
    writeFileSync(
      SRT,
      "1\n00:00:01,000 --> 00:00:02,500\nOlá legenda\n\n2\n00:00:03,000 --> 00:00:04,000\nSegunda fala\n",
      "utf8",
    );

    // O MKV "rico": vídeo + faixa 440 Hz "Microfone" + faixa 880 Hz "Áudio do
    // sistema" + a legenda subrip. Os títulos entram como o LocalRecord os põe
    // (`-metadata:s:a:N title=…`, ver buildAudio de lá).
    const base = [
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=6",
      "-f", "lavfi", "-i", `sine=frequency=${FREQ_MIC}:duration=6`,
      "-f", "lavfi", "-i", `sine=frequency=${FREQ_SYS}:duration=6`,
      "-i", SRT,
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
      "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-metadata:s:a:0", `title=${MIC}`,
      "-metadata:s:a:1", `title=${SYS}`,
      "-metadata:s:s:0", "language=por",
    ];
    ffmpeg([...base, "-c:s", "srt", MKV]);
    // O MP4 nativo: legenda vira mov_text, e o nome de faixa entra do único
    // jeito que o container MP4 preserva — `handler_name` (medido; o `title` o
    // muxer descarta, ver o teste do remux abaixo).
    ffmpeg([
      ...base, "-c:s", "mov_text",
      "-metadata:s:a:0", `handler_name=${MIC}`,
      "-metadata:s:a:1", `handler_name=${SYS}`,
      MP4,
    ]);

    // O take "do LocalRecord": MKV com vídeo + 2 áudios nomeados, SEM legenda —
    // é exatamente o que `buildRecordArgs` com audioTracks=separate produz.
    ffmpeg([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=4",
      "-f", "lavfi", "-i", `sine=frequency=${FREQ_MIC}:duration=4`,
      "-f", "lavfi", "-i", `sine=frequency=${FREQ_SYS}:duration=4`,
      "-map", "0:v", "-map", "1:a", "-map", "2:a",
      "-c:v", "libx264", "-g", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-metadata:s:a:0", `title=${MIC}`,
      "-metadata:s:a:1", `title=${SYS}`,
      REC,
    ]);
  });

  it("GATE probe: o ffprobe real (args do media.rs) lista as 2 faixas COM títulos e a legenda", () => {
    const j = probeJson(MKV);
    const audios = j.streams.filter((s) => s.codec_type === "audio");
    const subs = j.streams.filter((s) => s.codec_type === "subtitle");
    // As duas faixas estão lá, na ordem, com os nomes que o Record escreve —
    // é a prova de que os fixtures de `media.rs` (COM_LEGENDAS etc.) não são
    // invenção: o binário embarcado devolve exatamente esta forma.
    expect(audios).toHaveLength(2);
    expect(audios[0].tags?.title).toBe(MIC);
    expect(audios[1].tags?.title).toBe(SYS);
    expect(subs).toHaveLength(1);
    expect(subs[0].codec_name).toBe("subrip");
    expect(subs[0].tags?.language).toBe("por");
    console.log(`\n  [prova] probe MKV: 2 áudios ("${MIC}", "${SYS}") + 1 legenda subrip (por)\n`);
  });

  it("GATE detachAudio→export: cada clipe separado carrega o TOM da sua faixa (440 vs 880)", () => {
    // O caminho INTEIRO do app: importa (appendMedia), separa (detachAudio com
    // as 2 faixas do probe) — e cada clipe de áudio que nasceu vira um export
    // solo, medido no PCM.
    let tl = newTimeline();
    tl = appendMedia(tl, { path: MKV, srcIn: 0, srcOut: 6000 });
    const vid = baseVideoTrack(tl)!.clips[0];
    tl = detachAudio(tl, vid.id, 2);

    const aclips = tl.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips);
    expect(aclips).toHaveLength(2);
    expect(aclips.map((c) => c.audioStreamIndex).sort()).toEqual([0, 1]);

    const freqs: number[] = [];
    for (const c of aclips) {
      // O export solo deste clipe (a MESMA filterComplexArgs de produção). O
      // gate de string junto: o mapa tem que endereçar `a:N`, não `a` cru.
      const solo = timeline([atrack([{ ...c, startMs: 0 }])]);
      const out = join(DIR, `detached-a${c.audioStreamIndex}.mp4`);
      const args = filterComplexArgs(solo, { [MKV]: sourceOf(MKV) }, out);
      expect(args.join(" ")).toContain(`:a:${c.audioStreamIndex}]`);
      ffmpeg(args);
      const f = dominantFreq(out, 0.5, 2);
      freqs.push(f);
      const expected = c.audioStreamIndex === 0 ? FREQ_MIC : FREQ_SYS;
      // ±10%: AAC + reamostragem não movem um seno puro nem perto disso; o que
      // este teste pega é faixa TROCADA (440↔880, erro de 100%).
      expect(Math.abs(f - expected)).toBeLessThan(expected * 0.1);
    }
    console.log(
      `\n  [prova] detachAudio: faixa 0 → ${freqs[0]?.toFixed(1)} Hz (alvo ${FREQ_MIC}) · ` +
        `faixa 1 → ${freqs[1]?.toFixed(1)} Hz (alvo ${FREQ_SYS})\n`,
    );
  });

  it("GATE legenda embutida (MKV/subrip): extração real → parseSubtitles → clipes de título", () => {
    // Os MESMOS flags que o `extract_text` do Rust injeta + os args de produção.
    const raw = execFileSync(
      FFMPEG,
      ["-hide_banner", "-nostdin", "-loglevel", "error", ...subtitleExtractArgs(MKV, 0)],
      { encoding: "utf8" },
    );
    const cues = parseSubtitles(raw);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ startMs: 1000, text: "Olá legenda" });
    expect(cues[0].durationMs).toBe(1500);
    expect(cues[1]).toMatchObject({ startMs: 3000, text: "Segunda fala" });

    // E os cues viram clipes de título numa trilha nova — o mesmo caminho do
    // arquivo externo (importEmbeddedSubtitles desemboca em importSubtitles).
    let tl = newTimeline();
    tl = appendMedia(tl, { path: MKV, srcIn: 0, srcOut: 6000 });
    const before = tl.tracks.length;
    tl = addSubtitles(tl, cues);
    expect(tl.tracks.length).toBe(before + 1);
    const titles = tl.tracks[tl.tracks.length - 1].clips;
    expect(titles).toHaveLength(2);
    expect(titles.every(isTitle)).toBe(true);
    expect(titles[0].title!.text).toBe("Olá legenda");
    console.log(`\n  [prova] legenda MKV: 2 cues extraídos e virando 2 clipes de título\n`);
  });

  it("GATE legenda embutida (MP4/mov_text): o MESMO caminho converte pra SRT e importa", () => {
    // mov_text não é texto: sem a conversão `-f srt` do subtitleExtractArgs,
    // o parseSubtitles não teria o que ler. Este gate prova a conversão.
    const raw = execFileSync(
      FFMPEG,
      ["-hide_banner", "-nostdin", "-loglevel", "error", ...subtitleExtractArgs(MP4, 0)],
      { encoding: "utf8" },
    );
    const cues = parseSubtitles(raw);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("Olá legenda");
    expect(cues[1].startMs).toBe(3000);
  });

  it("MEDIÇÃO Record-vs-Video: o remux `-map 0 -c copy` PRESERVA as 2 faixas; quem come os títulos é o muxer MP4", () => {
    // Os args LITERAIS do buildRemuxArgs do LocalRecord (src/lib/args.ts de lá).
    const remuxed = join(DIR, "rec-remux.mp4");
    ffmpeg(["-i", REC, "-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", remuxed]);

    const j = probeJson(remuxed);
    const audios = j.streams.filter((s) => s.codec_type === "audio");
    // As DUAS faixas atravessam o remux — o Record NÃO perde faixa.
    expect(audios).toHaveLength(2);
    // …mas os títulos não: o muxer MP4 os descarta e sobra o handler genérico.
    // (No MKV original eles estão lá — o probe do take .mkv prova.)
    expect(audios[0].tags?.title).toBeUndefined();
    expect(audios[1].tags?.title).toBeUndefined();
    expect(audios[0].tags?.handler_name).toBe("SoundHandler");

    const mkvAudios = probeJson(REC).streams.filter((s) => s.codec_type === "audio");
    expect(mkvAudios[0].tags?.title).toBe(MIC);
    expect(mkvAudios[1].tags?.title).toBe(SYS);

    // O jeito que SOBREVIVE no MP4 (e que o stream_title do media.rs já lê):
    // handler_name setado de propósito. É o conserto de uma linha pro Record.
    const fixed = join(DIR, "rec-remux-fixed.mp4");
    ffmpeg([
      "-i", REC, "-map", "0", "-c", "copy",
      "-metadata:s:a:0", `handler_name=${MIC}`,
      "-metadata:s:a:1", `handler_name=${SYS}`,
      "-movflags", "+faststart", "-f", "mp4", fixed,
    ]);
    const fj = probeJson(fixed).streams.filter((s) => s.codec_type === "audio");
    expect(fj[0].tags?.handler_name).toBe(MIC);
    expect(fj[1].tags?.handler_name).toBe(SYS);
    console.log(
      "\n  [prova] remux Record: 2 faixas OK; títulos descartados pelo muxer MP4 " +
        "(handler_name explícito sobrevive — conserto de uma linha no buildRemuxArgs)\n",
    );
  });
});
