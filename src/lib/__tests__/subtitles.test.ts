import { describe, expect, it } from "vitest";

import { parseSubtitles } from "../subtitles";

describe("parseSubtitles", () => {
  it("lê um SRT simples (vírgula no ms)", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,500
Olá mundo

2
00:00:04,000 --> 00:00:06,000
Segunda linha`;
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startMs: 1000, durationMs: 2500, text: "Olá mundo" });
    expect(cues[1].startMs).toBe(4000);
  });

  it("lê um VTT (ponto no ms, cabeçalho WEBVTT, sem hora)", () => {
    const vtt = `WEBVTT

NOTE isto é um comentário

00:01.000 --> 00:03.000
Sem a hora`;
    const cues = parseSubtitles(vtt);
    // O WEBVTT e o NOTE não viram cue.
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({ startMs: 1000, durationMs: 2000, text: "Sem a hora" });
  });

  it("tira as tags inline do VTT (o drawtext não as entende)", () => {
    const vtt = `WEBVTT

00:00.000 --> 00:02.000
<i>itálico</i> e <c.amarelo>cor</c>`;
    expect(parseSubtitles(vtt)[0].text).toBe("itálico e cor");
  });

  it("junta as linhas de um bloco preservando a quebra", () => {
    const srt = `1
00:00:00,000 --> 00:00:02,000
linha um
linha dois`;
    expect(parseSubtitles(srt)[0].text).toBe("linha um\nlinha dois");
  });

  it("bloco sem tempo válido é PULADO, não derruba o resto", () => {
    const srt = `1
tempo quebrado aqui
lixo

2
00:00:05,000 --> 00:00:07,000
esta vale`;
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("esta vale");
  });

  it("fim <= início é descartado (cue degenerado)", () => {
    const srt = `1
00:00:05,000 --> 00:00:05,000
zero de duração

2
00:00:10,000 --> 00:00:08,000
fim antes do começo`;
    expect(parseSubtitles(srt)).toHaveLength(0);
  });

  it("ordena por tempo mesmo se o arquivo vier fora de ordem", () => {
    const srt = `1
00:00:10,000 --> 00:00:11,000
segundo

2
00:00:02,000 --> 00:00:03,000
primeiro`;
    const cues = parseSubtitles(srt);
    expect(cues.map((c) => c.text)).toEqual(["primeiro", "segundo"]);
  });

  it("aguenta BOM, CRLF e `.5` = 500ms", () => {
    const srt = "﻿1\r\n00:00:01.5 --> 00:00:02.5\r\nmeio segundo\r\n";
    const cues = parseSubtitles(srt);
    expect(cues[0].startMs).toBe(1500);
    expect(cues[0].durationMs).toBe(1000);
  });

  it("texto vazio depois de limpar as tags não vira cue", () => {
    const vtt = `WEBVTT

00:00.000 --> 00:02.000
<c.x></c>`;
    expect(parseSubtitles(vtt)).toHaveLength(0);
  });
});
