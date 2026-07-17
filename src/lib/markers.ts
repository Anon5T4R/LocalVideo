/**
 * Marcadores: instantes anotados durante uma gravação, que viram cortes aqui.
 *
 * ─── O ESTADO REAL DA PONTE COM O LOCALRECORD (verificado em 2026-07-17) ─────
 *
 * **O LocalRecord v0.1.2 NÃO exporta marcador nenhum. Não hoje.** Isto foi
 * conferido no código dele, não suposto:
 *
 * - Não existe conceito de marcador lá. O que se chama "anotação" no LocalRecord
 *   (`src/lib/annot.ts`, `AnnotOverlay.tsx`) é **desenho a caneta na tela** — o
 *   tipo é `{ kind, pts: {x,y}[], color, width }`, puramente espacial, **sem
 *   nenhum campo de tempo**. É um falso amigo: "anotação" ali é pixel, não
 *   instante. Os desenhos só existem como imagem dentro do vídeo, porque o
 *   ffmpeg grava a janela do overlay — não são dado.
 * - Ele não teria nem como gravar um arquivo: o `Cargo.toml` dele não tem
 *   `tauri-plugin-fs` nem `tauri-plugin-dialog`, e o `capabilities/default.json`
 *   não concede permissão de `fs:` nenhuma. Os 13 comandos dele não incluem
 *   nada de salvar/exportar. Depois de gravar, o que fica no disco é **um** `.mp4`
 *   e mais nada — sem `.json` ao lado.
 *
 * Por isso **não há formato do LocalRecord pra ler, e inventar um seria pior que
 * não ter**: o app fingiria uma ponte que não existe, e quando o LocalRecord
 * ganhasse marcadores de verdade, o formato chutado aqui estaria no caminho.
 *
 * O que existe, então, é o que dá pra fazer com honestidade: **o LocalVideo lê
 * um JSON de marcadores simples** — o formato abaixo, que é NOSSO e está
 * documentado. Quando o LocalRecord ganhar a tecla de "soltar marcador"
 * (o lugar natural é o mecanismo de atalho global que ele já tem), o lado de cá
 * já está pronto: é só ele escrever este arquivo.
 *
 * ─── O formato ──────────────────────────────────────────────────────────────
 *
 * ```json
 * {
 *   "app": "LocalRecord",
 *   "version": 1,
 *   "source": "C:\\gravacoes\\aula.mp4",
 *   "markers": [ { "tMs": 1500, "label": "intro" }, { "tMs": 42000 } ]
 * }
 * ```
 *
 * - `tMs` é **milissegundo**, e o nome diz a unidade de propósito. Um campo `t`
 *   solto seria a próxima pergunta ("segundo ou ms?") e a próxima hora perdida:
 *   30 s e 30 ms parecem os dois plausíveis num arquivo de exemplo, e o erro
 *   sairia como corte no lugar errado, não como erro.
 * - `source` (opcional) é a qual arquivo os instantes se referem. Marcador é
 *   tempo DENTRO da gravação, não tempo da timeline — os dois só coincidem
 *   enquanto o clipe está inteiro e sozinho.
 * - Também se aceita um array pelado (`[1500, 42000]` ou `[{"tMs":1500}]`),
 *   porque é o que sai de um script de três linhas — e um script de três linhas
 *   é exatamente o que alguém vai escrever pra testar isto.
 */

import { clipStarts, split, type Track } from "./timeline";

export interface Marker {
  /** Instante DENTRO do arquivo gravado, em milissegundos. */
  tMs: number;
  label?: string;
}

export interface MarkerFile {
  markers: Marker[];
  /** A qual arquivo os instantes se referem (`null` = o arquivo não disse). */
  source: string | null;
}

export class MarkerParseError extends Error {}

/**
 * Lê um JSON de marcadores. Desconfiado: o arquivo veio do disco e pode ter sido
 * escrito à mão ou por um script de outra pessoa.
 *
 * Marcador inválido é **descartado em silêncio**, não derruba o arquivo: um
 * `tMs` negativo no meio de vinte marcadores bons não pode custar os vinte. Mas
 * "não sobrou nenhum" é erro, sim — senão o app diria "importei!" e não cortaria
 * nada, que é a pior das respostas.
 */
export function parseMarkers(json: string): MarkerFile {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new MarkerParseError("json");
  }

  const raw: unknown[] = Array.isArray(doc)
    ? doc
    : doc && typeof doc === "object" && Array.isArray((doc as { markers?: unknown[] }).markers)
      ? (doc as { markers: unknown[] }).markers
      : (() => {
          throw new MarkerParseError("json");
        })();

  const source =
    !Array.isArray(doc) && doc && typeof doc === "object"
      ? typeof (doc as { source?: unknown }).source === "string" &&
        (doc as { source: string }).source
        ? (doc as { source: string }).source
        : null
      : null;

  const markers: Marker[] = [];
  for (const m of raw) {
    // `[1500, 3000]` — o array pelado de números.
    if (typeof m === "number") {
      if (Number.isFinite(m) && m >= 0) markers.push({ tMs: Math.round(m) });
      continue;
    }
    if (!m || typeof m !== "object") continue;
    const o = m as { tMs?: unknown; label?: unknown };
    if (typeof o.tMs !== "number" || !Number.isFinite(o.tMs) || o.tMs < 0) continue;
    markers.push({
      tMs: Math.round(o.tMs),
      ...(typeof o.label === "string" && o.label ? { label: o.label } : {}),
    });
  }

  if (markers.length === 0) throw new MarkerParseError("empty");
  markers.sort((a, b) => a.tMs - b.tMs);
  return { markers, source };
}

/**
 * Traduz um instante do ARQUIVO pros instantes da TIMELINE em que ele aparece.
 *
 * Devolve uma LISTA, e o plural é o ponto: depois de cortar e reordenar, o mesmo
 * segundo do arquivo original pode estar em dois lugares do filme — ou em nenhum
 * (o trecho foi aparado fora). Quem trata isso como "um instante vira um
 * instante" erra calado no dia em que o usuário duplica um clipe.
 *
 * O `srcOut` é exclusivo: um marcador no fim exato de um clipe pertence ao
 * próximo, não a este. É a mesma fronteira meio-aberta do `timeToClip`.
 */
export function sourceToTimeline(track: Track, source: string, srcMs: number): number[] {
  const starts = clipStarts(track);
  const out: number[] = [];
  track.clips.forEach((c, i) => {
    if (c.path !== source) return;
    if (srcMs < c.srcIn || srcMs >= c.srcOut) return;
    out.push(starts[i] + (srcMs - c.srcIn));
  });
  return out;
}

export interface ApplyResult {
  track: Track;
  /** Quantos marcadores viraram corte de verdade. */
  applied: number;
  /** Quantos caíram fora do que sobrou na timeline (trecho aparado, ou emenda). */
  skipped: number;
}

/**
 * Corta a timeline em cada marcador.
 *
 * `source` é o arquivo a que os instantes se referem. Quando o arquivo de
 * marcadores não diz (`source: null`), quem chama decide — e a UI só oferece a
 * importação quando a resposta é óbvia (um arquivo só na timeline). Adivinhar o
 * arquivo com dois candidatos seria cortar o vídeo errado.
 *
 * Um marcador que não vira corte não é erro: cair numa emenda que já existe, ou
 * num trecho que foi aparado fora, é um não-evento. O `split()` devolve a mesma
 * trilha nesses casos e a gente só conta.
 */
export function applyMarkers(track: Track, source: string, markers: Marker[]): ApplyResult {
  let out = track;
  let applied = 0;
  let skipped = 0;

  for (const m of markers) {
    // Recalculado a CADA marcador contra a trilha já cortada: cortar não muda
    // durações nem ordem, mas muda em qual clipe o instante cai — e é o clipe
    // que o `split` precisa achar.
    const times = sourceToTimeline(out, source, m.tMs);
    if (times.length === 0) {
      skipped++;
      continue;
    }
    let did = false;
    for (const t of times) {
      const next = split(out, t);
      if (next !== out) {
        out = next;
        did = true;
      }
    }
    if (did) applied++;
    else skipped++;
  }

  return { track: out, applied, skipped };
}
