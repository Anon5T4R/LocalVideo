/** Importar legendas (.srt / .vtt) — parser PURO e testado.
 *
 *  Uma legenda é, no modelo deste app, um clipe de TÍTULO com janela de tempo:
 *  o `drawtext` que renderiza título já cobre a exibição, e o inspetor já edita
 *  título (texto, fonte, âncora). Então importar legenda é PARSEAR o arquivo e
 *  virar clipes de título ancorados embaixo — a edição vem de graça.
 *
 *  Molde: o `markers.ts`, que já é "arquivo-texto → itens de timeline". A
 *  diferença é o formato (SRT/VTT em vez de JSON) e que cada item tem DURAÇÃO,
 *  não só um instante.
 *
 *  SRT e VTT são quase o mesmo formato de bloco; as diferenças que importam:
 *   - o separador de milissegundos é `,` no SRT e `.` no VTT — aceitamos os dois;
 *   - o VTT abre com uma linha `WEBVTT` e pode ter blocos `NOTE`/`STYLE`, que se
 *     ignora;
 *   - as tags inline (`<i>`, `<b>`, `<c.cor>`) do VTT viram texto puro — o
 *     `drawtext` não as entende, e legenda com `<i>` cru na tela é pior que sem.
 */

export interface SubCue {
  startMs: number;
  /** Duração na timeline, em ms (fim − início). */
  durationMs: number;
  text: string;
}

/** `HH:MM:SS,mmm` ou `HH:MM:SS.mmm` (o VTT admite `MM:SS.mmm` sem a hora). */
function parseTimestamp(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, hh, mm, ss, ms] = m;
  const h = hh ? Number(hh) : 0;
  // `padEnd` porque `.5` no VTT é 500ms, não 5.
  const millis = Number(ms.padEnd(3, "0"));
  return ((h * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + millis;
}

/** Tira tags inline do VTT e junta as linhas do bloco num texto só. O
 *  `drawtext` quebra linha com `\n` de verdade, então preserva-se a quebra. */
function cleanText(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/<[^>]+>/g, "") // <i>, <b>, <c.cor>, <00:00:01.000> (karaokê)
    .replace(/\{[^}]*\}/g, "") // marcações SSA/ASS que às vezes vazam
    .trim();
}

/**
 * Parseia SRT ou VTT. Detecta pelo conteúdo, não pela extensão (o usuário pode
 * ter renomeado; e o que manda é o que está dentro).
 *
 * Robusto de propósito: um bloco sem tempo válido é PULADO, não derruba o resto
 * — arquivo de legenda do mundo real tem lixo (numeração fora de ordem, bloco
 * vazio, BOM no começo). Devolve os cues em ordem de tempo.
 */
export function parseSubtitles(raw: string): SubCue[] {
  // Tira o BOM e normaliza quebra de linha (Windows/Mac/Unix num arquivo só).
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/\n\s*\n/);
  const cues: SubCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    // Cabeçalho do VTT e blocos de metadado não são cue.
    if (/^WEBVTT/.test(lines[0]) || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;

    // A linha do tempo é a que tem `-->`. O número/id do SRT (linha antes) e o
    // cue-id opcional do VTT são ignorados: acha-se a seta onde ela estiver.
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;

    const [a, b] = lines[ti].split("-->");
    const start = parseTimestamp(a ?? "");
    // O fim pode ter "posições" depois do timestamp (`... --> ...  line:90%`).
    const end = parseTimestamp((b ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;

    const body = cleanText(lines.slice(ti + 1));
    if (body === "") continue;

    cues.push({ startMs: start, durationMs: end - start, text: body });
  }

  return cues.sort((x, y) => x.startMs - y.startMs);
}
