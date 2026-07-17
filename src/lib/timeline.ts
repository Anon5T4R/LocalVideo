/**
 * O modelo da timeline — TS puro, sem React, sem Tauri. É o coração do app e
 * por isso mora aqui: dá pra testar cada operação sem abrir janela nenhuma.
 *
 * Modelo mental: **uma trilha de vídeo**, uma lista ORDENADA de clipes. Cada
 * clipe é uma janela (`srcIn`..`srcOut`) sobre um arquivo (`path`) — nunca uma
 * cópia do vídeo. Cortar não mexe em byte nenhum: só cria duas janelas onde
 * havia uma. É isso que faz o editor ser instantâneo e não destrutivo.
 *
 * Tempo é em MILISSEGUNDOS inteiros, sempre. Float em tempo de mídia acumula
 * erro e o corte "some" meio quadro depois de dez operações.
 *
 * Dois espaços de tempo, e confundi-los é O bug clássico de NLE:
 * - **tempo da timeline**: 0 = começo do filme montado.
 * - **tempo-fonte**: instante DENTRO do arquivo original.
 * `timeToClip()` é a ponte entre os dois.
 */

export interface Clip {
  id: string;
  /** Caminho do arquivo no disco (o projeto guarda caminho, não vídeo). */
  path: string;
  /** Início da janela, em ms do arquivo-fonte. */
  srcIn: number;
  /** Fim da janela (exclusivo), em ms do arquivo-fonte. */
  srcOut: number;
}

export interface Track {
  clips: Clip[];
}

/** Quanto tempo este clipe ocupa na timeline. */
export function clipDuration(c: Clip): number {
  return Math.max(0, c.srcOut - c.srcIn);
}

/** Duração do filme montado = soma dos clipes (uma trilha, sem buracos). */
export function totalDuration(track: Track): number {
  return track.clips.reduce((sum, c) => sum + clipDuration(c), 0);
}

/** Instante da timeline em que cada clipe COMEÇA (mesma ordem de `clips`). */
export function clipStarts(track: Track): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const c of track.clips) {
    starts.push(acc);
    acc += clipDuration(c);
  }
  return starts;
}

export interface Hit {
  clip: Clip;
  index: number;
  /** Instante DENTRO do arquivo-fonte correspondente ao `t` pedido. */
  srcTime: number;
  /** Onde o clipe começa na timeline (pra UI não recalcular). */
  clipStart: number;
}

/**
 * Dado um instante da timeline, qual clipe toca e em que ponto do arquivo.
 * A pergunta que o preview e o playhead fazem o tempo todo.
 *
 * Fronteira é meio-aberta (`[start, end)`): no instante exato da emenda quem
 * toca é o clipe da DIREITA — é o que o olho espera ao arrastar o playhead.
 * `t` no fim exato do filme não é clipe nenhum (`null`): é o fim, não o
 * primeiro quadro de um clipe inexistente.
 */
export function timeToClip(track: Track, t: number): Hit | null {
  if (t < 0) return null;
  let acc = 0;
  for (let i = 0; i < track.clips.length; i++) {
    const c = track.clips[i];
    const d = clipDuration(c);
    if (d === 0) continue; // clipe de duração zero não pode "engolir" o playhead
    if (t < acc + d) {
      return { clip: c, index: i, srcTime: c.srcIn + (t - acc), clipStart: acc };
    }
    acc += d;
  }
  return null;
}

/** Gerador de id. Simples de propósito: só precisa ser único na sessão. */
let seq = 0;
export function newId(prefix = "c"): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Zera o contador — só os testes usam (deixa os ids previsíveis). */
export function __resetIds() {
  seq = 0;
}

/**
 * Corta a timeline no instante `at`, virando um clipe em dois.
 *
 * Não é erro cortar onde não dá — é um não-evento: cortar em cima de uma emenda
 * (ou no 0, ou no fim) devolve a MESMA trilha. Assim o atalho `S` nunca "dá
 * erro" na cara do usuário; ele só não faz nada quando não há o que fazer.
 * Devolver a mesma referência também deixa o undo/redo não empilhar lixo.
 */
export function split(track: Track, at: number): Track {
  const hit = timeToClip(track, at);
  if (!hit) return track;
  const srcAt = hit.srcTime;
  // Em cima da borda do clipe não há corte: já existe emenda ali.
  if (srcAt <= hit.clip.srcIn || srcAt >= hit.clip.srcOut) return track;

  const left: Clip = { ...hit.clip, srcOut: srcAt };
  const right: Clip = { ...hit.clip, id: newId(), srcIn: srcAt };
  const clips = [...track.clips];
  clips.splice(hit.index, 1, left, right);
  return { clips };
}

/**
 * Apara um clipe (nova janela sobre o mesmo arquivo).
 *
 * Blindagens (o usuário arrasta a alça, ele não digita ms):
 * - `in`/`out` invertidos ⇒ trocados. Arrastar a alça esquerda passando da
 *   direita é gesto comum; virar erro seria pedantice.
 * - a janela não pode sair do arquivo (`0..limite`), senão o export dá preto.
 * - janela vazia (`in == out`) ⇒ ignorada: quem quer sumir com o clipe usa
 *   `remove` (e o undo devolve). Aparar até zero é acidente, não intenção.
 */
export function trim(track: Track, id: string, srcIn: number, srcOut: number, srcLimit?: number): Track {
  const i = track.clips.findIndex((c) => c.id === id);
  if (i < 0) return track;

  let a = Math.round(Math.min(srcIn, srcOut));
  let b = Math.round(Math.max(srcIn, srcOut));
  const max = srcLimit ?? Math.max(b, track.clips[i].srcOut);
  a = Math.max(0, Math.min(a, max));
  b = Math.max(0, Math.min(b, max));
  if (b - a <= 0) return track;

  const clips = [...track.clips];
  clips[i] = { ...clips[i], srcIn: a, srcOut: b };
  return { clips };
}

/**
 * Reordena: tira o clipe de onde está e põe no índice `toIndex` da lista JÁ SEM
 * ele — que é exatamente o que o olho vê ao arrastar. Índice fora da faixa é
 * grampeado (soltar depois do último = último), nunca erro.
 */
export function move(track: Track, id: string, toIndex: number): Track {
  const from = track.clips.findIndex((c) => c.id === id);
  if (from < 0) return track;
  const clips = [...track.clips];
  const [c] = clips.splice(from, 1);
  const to = Math.max(0, Math.min(Math.round(toIndex), clips.length));
  if (to === from) return track;
  clips.splice(to, 0, c);
  return { clips };
}

export function remove(track: Track, id: string): Track {
  const clips = track.clips.filter((c) => c.id !== id);
  return clips.length === track.clips.length ? track : { clips };
}

export function append(track: Track, clip: Clip): Track {
  return { clips: [...track.clips, clip] };
}

/* ------------------------------------------------------------------ */
/* Undo / redo                                                         */
/* ------------------------------------------------------------------ */

/**
 * Histórico de ESTADOS (não de comandos). Cabe porque uma trilha é uma lista
 * rasa de objetinhos: guardar 100 retratos dela custa nada, e retrato não tem
 * como "desfazer errado" — o inverso de um comando, tem.
 *
 * Editor sem undo não é produto. É o requisito, não um extra.
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const HISTORY_LIMIT = 200;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/**
 * Empurra um novo estado. Se a operação não mudou nada (as puras acima devolvem
 * a MESMA referência nesse caso), o histórico não se mexe: senão o Ctrl+Z do
 * usuário gastaria passos desfazendo não-eventos.
 */
export function pushHistory<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  const past = [...h.past, h.present].slice(-HISTORY_LIMIT);
  // Editar depois de desfazer queima o futuro — é o contrato de todo editor.
  return { past, present: next, future: [] };
}

/**
 * Troca o presente SEM mexer no passado nem no futuro.
 *
 * Existe por causa do arrasto contínuo (aparar pela alça): o `pointermove`
 * dispara dezenas de vezes por segundo e empilhar cada um fazia duas maldades.
 * A óbvia: desfazer UM aparo virava "segurar Ctrl+Z" — medido na janela real, um
 * arrasto de 80px voltava 4px por Ctrl+Z. A silenciosa, e pior: cada passo
 * intermediário comia uma vaga do `HISTORY_LIMIT`, então um arrasto demorado
 * empurrava pra fora do histórico o import e os cortes DE VERDADE.
 *
 * Quem arrasta empilha UMA vez, no primeiro movimento (guardando o estado de
 * antes), e daí em diante só troca o presente. O resultado é o que o usuário
 * espera: um aparo = um Ctrl+Z.
 */
export function replacePresent<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: h.past, present: next, future: h.future };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}
export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const present = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [present, ...future] = h.future;
  return { past: [...h.past, h.present], present, future };
}
