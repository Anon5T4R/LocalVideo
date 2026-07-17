/**
 * O modelo da timeline — TS puro, sem React, sem Tauri. É o coração do app e
 * por isso mora aqui: dá pra testar cada operação sem abrir janela nenhuma.
 *
 * ─── O salto da v0.1 pra v0.2 ────────────────────────────────────────────────
 *
 * A v0.1 era **uma trilha, lista ORDENADA de clipes** — a posição no tempo era
 * implícita (a soma das durações anteriores). Isso casava com o export por
 * `concat` (clipes em sequência), mas não dá conta de multitrilha nem de
 * transição: dois clipes que se SOBREPÕEM no tempo não cabem numa lista sem
 * posição.
 *
 * Na v0.2 cada clipe tem **posição explícita** (`startMs`) e **duração na
 * timeline** (`durationMs`). Com isso vêm de graça: buracos (preto/silêncio),
 * trilhas empilhadas (overlay de vídeo, mix de áudio) e — a sacada — a
 * **transição é uma SOBREPOSIÇÃO**: quando dois clipes da mesma trilha se
 * cruzam no tempo, aquele cruzamento É o crossfade. Uma fonte da verdade só
 * (`startMs`+`durationMs`), sem um campo `transição` paralelo pra sair de
 * sincronia — que é O bug clássico de NLE.
 *
 * Tempo é em MILISSEGUNDOS inteiros, sempre. Float em tempo de mídia acumula
 * erro e o corte "some" meio quadro depois de dez operações.
 *
 * Dois espaços de tempo, e confundi-los é o outro bug clássico:
 * - **tempo da timeline**: 0 = começo do filme montado (`startMs`).
 * - **tempo-fonte**: instante DENTRO do arquivo original (`srcIn`).
 */

export const TIMELINE_VERSION = 2;

export type TrackKind = "video" | "audio";

/** Onde o título se ancora na tela. Nove âncoras seria over-engineering pro que
 *  a UI precisa; três resolvem 99% (legenda embaixo, título no meio, marca em
 *  cima). O compilador traduz isto em expressão de posição do `drawtext`. */
export type TitleAnchor = "top" | "center" | "bottom";

export interface TitleProps {
  text: string;
  fontSizePx: number;
  /** Cor no formato do ffmpeg: "#RRGGBB" ou nome ("white"). */
  color: string;
  anchor: TitleAnchor;
}

/** Recorte do frame-fonte, em FRAÇÕES 0..1 (resolução-independente: guardar em
 *  pixels amarraria o corte à resolução exata do arquivo). x/y = canto sup-esq. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Transform (o PiP): onde e quão grande o clipe entra por cima. `x`/`y` são a
 *  posição do canto sup-esq como FRAÇÃO do canvas de saída; `scale` é a largura
 *  do clipe como fração da largura de saída (0.3 = 30%). Reusa o overlay da v0.2
 *  — sem transform, o clipe cobre o quadro inteiro (comportamento antigo). */
export interface Transform {
  x: number;
  y: number;
  scale: number;
}

/** Ajuste de cor (o `eq` do ffmpeg). brilho −1..1 (0=neutro, ADITIVO), contraste
 *  0..2 (1=neutro), saturação 0..3 (1=neutro). */
export interface ColorAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
}

/** Um ponto de envelope. `t` é FRAÇÃO da duração do clipe (0..1); `v` é o valor
 *  (opacidade 0..1 ou ganho de volume linear). Guardar em fração (não ms) faz o
 *  envelope sobreviver a aparar/mudar velocidade sem recalcular ponto a ponto. */
export interface Keyframe {
  t: number;
  v: number;
}

/**
 * Um clipe. Pode ser MÍDIA (janela sobre um arquivo) ou TÍTULO (texto). O que
 * distingue é a presença de `path` (mídia) ou `title` (texto) — nunca os dois.
 *
 * `durationMs` é a duração NA TIMELINE. Pra mídia, sem mudança de velocidade,
 * ela é igual à janela-fonte (`srcOut = srcIn + durationMs`). Guardar a duração
 * explícita (em vez de derivar de `srcOut`) unifica mídia e título: os dois
 * ocupam `[startMs, startMs+durationMs)` e o resto do código não precisa saber
 * qual é qual pra posicionar.
 */
export interface Clip {
  id: string;
  /** Início na timeline, em ms. */
  startMs: number;
  /** Duração na timeline, em ms. */
  durationMs: number;

  /* --- mídia (ausente em título) --- */
  /** Caminho do arquivo no disco (o projeto guarda caminho, não vídeo). */
  path?: string;
  /** Início da janela, em ms do arquivo-fonte. `srcOut` = `srcIn + durationMs`. */
  srcIn?: number;

  /* --- título (ausente em mídia) --- */
  title?: TitleProps;

  /* --- áudio (só faz sentido em clipe de mídia com som) --- */
  /** Silencia este clipe sem removê-lo. */
  muted?: boolean;
  /** Ganho linear. 1 = original, 0.5 = metade, 2 = dobro. `undefined` = 1. */
  volume?: number;
  fadeInMs?: number;
  fadeOutMs?: number;

  /* --- vídeo --- */
  /** Opacidade 0..1 pra overlay/título. `undefined` = 1 (opaco). */
  opacity?: number;

  /* --- filtros por clipe (v0.3) --- */
  /** Recorte do frame-fonte (frações 0..1). Ausente = usa o quadro inteiro. */
  crop?: CropRect;
  /** Posição+tamanho do overlay (PiP). Ausente = cobre o quadro (v0.2). */
  transform?: Transform;
  /** Brilho/contraste/saturação. Ausente = sem ajuste. */
  color?: ColorAdjust;

  /* --- velocidade (v0.3) --- */
  /** Fator de velocidade. 1 = normal, 2 = 2× (mais curto), 0.5 = câmera lenta.
   *  Invariante: a FONTE consumida = `durationMs * speed`. `undefined` = 1. */
  speed?: number;

  /* --- envelopes/keyframes (v0.3) --- */
  /** Envelope de opacidade ao longo do clipe. Ausente = usa `opacity` constante. */
  opacityKeyframes?: Keyframe[];
  /** Envelope de volume ao longo do clipe. Ausente = usa `volume` constante. */
  volumeKeyframes?: Keyframe[];
}

/** Uma trilha: clipes ORDENADOS por `startMs`. Vídeo empilha (overlay/z-order);
 *  áudio mixa. */
export interface Track {
  id: string;
  kind: TrackKind;
  clips: Clip[];
}

/** A timeline inteira. `version` mora aqui pra migração ao abrir um `.tvproj`. */
export interface Timeline {
  version: number;
  tracks: Track[];
}

/* ------------------------------------------------------------------ */
/* Gerador de id                                                       */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Leitura (puro)                                                      */
/* ------------------------------------------------------------------ */

export function isTitle(c: Clip): boolean {
  return c.title !== undefined;
}
export function isMedia(c: Clip): boolean {
  return c.path !== undefined;
}

/** Quanto o clipe ocupa na timeline. */
export function clipDuration(c: Clip): number {
  return Math.max(0, c.durationMs);
}

/** Fim do clipe na timeline (exclusivo). */
export function clipEnd(c: Clip): number {
  return c.startMs + clipDuration(c);
}

/** Velocidade efetiva (grampeada em positivo; `undefined` = 1). É o fator que
 *  liga tempo de timeline a tempo-fonte: 1 ms de timeline consome `speed` ms de
 *  fonte. Um único ponto de verdade pra toda a matemática de corte não esquecer
 *  a velocidade. */
export function clipSpeed(c: Clip): number {
  const s = c.speed ?? 1;
  return s > 0 ? s : 1;
}

/** Quanto de FONTE o clipe consome, em ms (a janela-fonte). Com velocidade, é
 *  `durationMs * speed` — 2× consome o dobro de fonte no mesmo tempo de tela. */
export function srcWindowMs(c: Clip): number {
  return clipDuration(c) * clipSpeed(c);
}

/** Fim da janela-fonte (só faz sentido em mídia). Considera a velocidade. */
export function srcOut(c: Clip): number {
  return (c.srcIn ?? 0) + srcWindowMs(c);
}

/** Fim da trilha = maior `clipEnd`. Trilha vazia = 0. */
export function trackEnd(track: Track): number {
  let end = 0;
  for (const c of track.clips) end = Math.max(end, clipEnd(c));
  return end;
}

/** Duração do filme = a trilha mais longa. */
export function timelineDuration(tl: Timeline): number {
  let d = 0;
  for (const t of tl.tracks) d = Math.max(d, trackEnd(t));
  return d;
}

/** Total de clipes (todas as trilhas) — a UI conta isto no cabeçalho. */
export function clipCount(tl: Timeline): number {
  return tl.tracks.reduce((n, t) => n + t.clips.length, 0);
}

/** A trilha de vídeo base (a primeira). É ela que a prévia mostra e a que o
 *  import alimenta. `null` se não houver trilha de vídeo (não deve acontecer). */
export function baseVideoTrack(tl: Timeline): Track | null {
  return tl.tracks.find((t) => t.kind === "video") ?? null;
}

export interface Located {
  clip: Clip;
  track: Track;
  ti: number;
  ci: number;
}

/** Acha um clipe pelo id, dizendo em que trilha/índice ele está. */
export function locate(tl: Timeline, id: string): Located | null {
  for (let ti = 0; ti < tl.tracks.length; ti++) {
    const track = tl.tracks[ti];
    const ci = track.clips.findIndex((c) => c.id === id);
    if (ci >= 0) return { clip: track.clips[ci], track, ti, ci };
  }
  return null;
}

export interface Hit {
  clip: Clip;
  index: number;
  /** Instante DENTRO do arquivo-fonte correspondente ao `t` pedido. */
  srcTime: number;
  /** Onde o clipe começa na timeline. */
  clipStart: number;
}

/**
 * Dado um instante da timeline, qual clipe de MÍDIA de uma trilha toca ali.
 * A prévia e o playhead perguntam isto o tempo todo (na trilha base).
 *
 * Se dois clipes se sobrepõem (crossfade), quem responde é o de CIMA — o
 * último na ordem — que é o que o olho vê no fim da transição. Buraco = `null`.
 */
export function timeToClip(track: Track | null, t: number): Hit | null {
  if (!track || t < 0) return null;
  let best: Hit | null = null;
  for (let i = 0; i < track.clips.length; i++) {
    const c = track.clips[i];
    const d = clipDuration(c);
    if (d === 0 || !isMedia(c)) continue;
    if (t >= c.startMs && t < clipEnd(c)) {
      // Tempo-fonte anda `speed` vezes mais rápido que o tempo de timeline.
      best = {
        clip: c,
        index: i,
        srcTime: (c.srcIn ?? 0) + (t - c.startMs) * clipSpeed(c),
        clipStart: c.startMs,
      };
    }
  }
  return best;
}

/**
 * O último quadro do filme — o `Hit` que o `timeToClip` de propósito NÃO dá no
 * fim exato. A prévia precisa mostrar algo em `t === total` (é onde o play
 * para); sem isto, assistir até o fim trocava o filme por "importe um vídeo".
 */
export function endHit(track: Track | null): Hit | null {
  if (!track) return null;
  let last: Hit | null = null;
  let bestEnd = -1;
  for (let i = 0; i < track.clips.length; i++) {
    const c = track.clips[i];
    if (clipDuration(c) === 0 || !isMedia(c)) continue;
    if (clipEnd(c) >= bestEnd) {
      bestEnd = clipEnd(c);
      last = { clip: c, index: i, srcTime: srcOut(c), clipStart: c.startMs };
    }
  }
  return last;
}

/** Onde cada clipe da trilha começa (pra UI). */
export function clipStarts(track: Track): number[] {
  return track.clips.map((c) => c.startMs);
}

/**
 * A sobreposição (crossfade) entre este clipe e o SEGUINTE da mesma trilha, em
 * ms. Zero quando não há sobreposição. É a duração da transição — não há campo
 * separado, a geometria É a transição.
 */
export function overlapWithNext(track: Track, index: number): number {
  const a = track.clips[index];
  const b = track.clips[index + 1];
  if (!a || !b) return 0;
  const ov = clipEnd(a) - b.startMs;
  return Math.max(0, Math.min(ov, clipDuration(a), clipDuration(b)));
}

/* ------------------------------------------------------------------ */
/* Construção                                                          */
/* ------------------------------------------------------------------ */

/** Uma timeline nova: uma trilha de vídeo, uma de áudio, ambas vazias. */
export function newTimeline(): Timeline {
  return {
    version: TIMELINE_VERSION,
    tracks: [
      { id: newId("vt"), kind: "video", clips: [] },
      { id: newId("at"), kind: "audio", clips: [] },
    ],
  };
}

/** Ordena os clipes de uma trilha por `startMs` (empate: mantém a ordem). */
function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs);
}

function withTrack(tl: Timeline, ti: number, clips: Clip[]): Timeline {
  const tracks = tl.tracks.slice();
  tracks[ti] = { ...tracks[ti], clips: sortClips(clips) };
  return { ...tl, tracks };
}

/**
 * Acrescenta um clipe de mídia no FIM da trilha base (import). Entra logo depois
 * do último clipe da trilha — sem buraco, como a v0.1 fazia. Se não houver
 * trilha de vídeo, é não-evento (não deve acontecer).
 */
export function appendMedia(
  tl: Timeline,
  media: { path: string; srcIn: number; srcOut: number },
): Timeline {
  const ti = tl.tracks.findIndex((t) => t.kind === "video");
  if (ti < 0) return tl;
  const track = tl.tracks[ti];
  const start = trackEnd(track);
  const clip: Clip = {
    id: newId(),
    startMs: start,
    durationMs: Math.max(0, media.srcOut - media.srcIn),
    path: media.path,
    srcIn: media.srcIn,
  };
  return withTrack(tl, ti, [...track.clips, clip]);
}

/** Adiciona uma trilha (vídeo empilha por cima; áudio mixa). */
export function addTrack(tl: Timeline, kind: TrackKind): Timeline {
  return { ...tl, tracks: [...tl.tracks, { id: newId(kind === "video" ? "vt" : "at"), kind, clips: [] }] };
}

/**
 * Cria um clipe de título numa trilha de vídeo. Fica na posição pedida, opaco,
 * pela duração pedida. O texto/fonte/cor vêm com padrão sensato — a UI ajusta.
 */
export function addTitle(
  tl: Timeline,
  trackId: string,
  startMs: number,
  durationMs: number,
  props: TitleProps,
): Timeline {
  const ti = tl.tracks.findIndex((t) => t.id === trackId && t.kind === "video");
  if (ti < 0) return tl;
  const clip: Clip = {
    id: newId("t"),
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: Math.max(100, Math.round(durationMs)),
    title: props,
  };
  return withTrack(tl, ti, [...tl.tracks[ti].clips, clip]);
}

/** Padrão de um título novo. */
export function defaultTitle(text = "Título"): TitleProps {
  return { text, fontSizePx: 48, color: "#ffffff", anchor: "bottom" };
}

/* ------------------------------------------------------------------ */
/* Edição (puro; devolve a MESMA referência quando é não-evento)       */
/* ------------------------------------------------------------------ */

/**
 * Corta um clipe no instante `at` da timeline, virando um em dois. Não é erro
 * cortar onde não dá (na borda, no vazio) — é não-evento, e devolve a MESMA
 * timeline (assim o `S` nunca "dá erro" e o undo não empilha lixo).
 */
export function splitAt(tl: Timeline, id: string, at: number): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const { clip, ti } = loc;
  // Em cima da borda não há corte: já existe emenda ali.
  if (at <= clip.startMs || at >= clipEnd(clip)) return tl;

  const leftDur = at - clip.startMs;
  const left: Clip = { ...clip, durationMs: leftDur };
  const right: Clip = {
    ...clip,
    id: newId(),
    startMs: at,
    durationMs: clipDuration(clip) - leftDur,
    // Mídia: a metade da direita começa mais adiante no arquivo-fonte — e com
    // velocidade, o avanço na fonte é `leftDur * speed` (não `leftDur`).
    ...(isMedia(clip) ? { srcIn: (clip.srcIn ?? 0) + leftDur * clipSpeed(clip) } : {}),
  };
  const clips = tl.tracks[ti].clips.slice();
  clips.splice(loc.ci, 1, left, right);
  return withTrack(tl, ti, clips);
}

/**
 * Apara um clipe por uma das bordas, arrastando-a pra `timelineMs`.
 *
 * - **borda "in"**: a borda ESQUERDA anda no tempo. O conteúdo do arquivo que
 *   aparece naquela borda NÃO muda de lugar (arrastar o começo revela/esconde o
 *   miolo). Logo `srcIn` anda junto com `startMs`. Blindado: `srcIn` não desce
 *   de 0, e a janela não fica vazia.
 * - **borda "out"**: a borda DIREITA anda; `srcOut` (= start+dur) não pode
 *   passar do fim do arquivo (`srcLimit`).
 *
 * Título não tem arquivo: aparar só muda a duração/posição na timeline.
 */
export function setClipEdge(
  tl: Timeline,
  id: string,
  edge: "in" | "out",
  timelineMs: number,
  srcLimit?: number,
): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const { clip, ti } = loc;
  const end = clipEnd(clip);
  const media = isMedia(clip);
  // Com velocidade, 1 ms de borda anda `speed` ms na fonte — os limites de fonte
  // (srcIn≥0, srcOut≤arquivo) viram limites de tempo de timeline dividindo por
  // `speed`.
  const sp = clipSpeed(clip);
  let next: Clip;

  if (edge === "in") {
    // A borda esquerda não pode passar da direita (mínimo 1 ms de clipe) nem
    // fazer o `srcIn` ficar negativo.
    const minStart = media ? clip.startMs - (clip.srcIn ?? 0) / sp : 0;
    const newStart = Math.round(Math.max(minStart, Math.min(timelineMs, end - 1)));
    const delta = newStart - clip.startMs;
    if (delta === 0) return tl;
    next = {
      ...clip,
      startMs: newStart,
      durationMs: clipDuration(clip) - delta,
      ...(media ? { srcIn: Math.max(0, Math.round((clip.srcIn ?? 0) + delta * sp)) } : {}),
    };
  } else {
    // A borda direita não pode passar do começo nem do fim do arquivo.
    let newEnd = Math.round(Math.max(clip.startMs + 1, timelineMs));
    if (media && srcLimit !== undefined) {
      const maxEnd = clip.startMs + (srcLimit - (clip.srcIn ?? 0)) / sp;
      newEnd = Math.min(newEnd, maxEnd);
    }
    const newDur = newEnd - clip.startMs;
    if (newDur === clipDuration(clip)) return tl;
    next = { ...clip, durationMs: newDur };
  }

  const clips = tl.tracks[ti].clips.slice();
  clips[loc.ci] = next;
  return withTrack(tl, ti, clips);
}

/**
 * Move um clipe no tempo e/ou entre trilhas. `toTrackId` pode ser a mesma
 * trilha (só reposiciona no tempo). Título não vai pra trilha de áudio.
 * `newStartMs` é grampeado em 0. Sobrepor vira crossfade — é intencional.
 */
export function moveClip(tl: Timeline, id: string, toTrackId: string, newStartMs: number): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const destTi = tl.tracks.findIndex((t) => t.id === toTrackId);
  if (destTi < 0) return tl;
  const dest = tl.tracks[destTi];
  // Título só em trilha de vídeo.
  if (isTitle(loc.clip) && dest.kind !== "video") return tl;

  const start = Math.max(0, Math.round(newStartMs));
  if (destTi === loc.ti && start === loc.clip.startMs) return tl;

  const moved: Clip = { ...loc.clip, startMs: start };
  let tracks = tl.tracks.slice();
  // Tira da origem.
  tracks[loc.ti] = {
    ...tracks[loc.ti],
    clips: tracks[loc.ti].clips.filter((c) => c.id !== id),
  };
  // Põe no destino (re-lê o índice: origem e destino podem ser a mesma).
  tracks[destTi] = {
    ...tracks[destTi],
    clips: sortClips([...tracks[destTi].clips, moved]),
  };
  return { ...tl, tracks };
}

export function removeClip(tl: Timeline, id: string): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const clips = loc.track.clips.filter((c) => c.id !== id);
  return withTrack(tl, loc.ti, clips);
}

/**
 * Aplica um patch de propriedades num clipe (volume, fade, opacidade, título).
 * Não mexe em posição/duração — pra isso há `moveClip`/`setClipEdge`. Ignora
 * chaves `undefined` pra não apagar o que não veio.
 */
export function updateClip(tl: Timeline, id: string, patch: ClipPatch): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const next: Clip = { ...loc.clip };
  const rec = next as unknown as Record<string, unknown>;
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // `null` REMOVE a propriedade — é como o inspetor zera um filtro (voltar a
    // "sem recorte", "sem cor"). Sem isto, um filtro aplicado nunca some de vez.
    if (v === null) {
      if (k in rec) {
        delete rec[k];
        changed = true;
      }
      continue;
    }
    if (rec[k] !== v) {
      rec[k] = v;
      changed = true;
    }
  }
  if (!changed) return tl;
  const clips = loc.track.clips.slice();
  clips[loc.ci] = next;
  return withTrack(tl, loc.ti, clips);
}

/** Patch aceito por `updateClip`: além de trocar valores, `null` REMOVE a chave
 *  (zerar um filtro). Objetos aninhados (crop/color/…) entram inteiros. */
export type ClipPatch = { [K in keyof Clip]?: Clip[K] | null };

/**
 * Muda a VELOCIDADE de um clipe de mídia. É a operação mais delicada da v0.3: a
 * janela-fonte é PRESERVADA (o mesmo conteúdo do arquivo), mas a duração NA
 * TIMELINE muda (2× encurta pela metade, ½× dobra). E aí vem o gotcha: mudar a
 * duração deste clipe move o começo de TODOS os que vinham depois na mesma
 * trilha — senão abre um buraco (ou uma sobreposição) que ninguém pediu. Por
 * isso os vizinhos à frente andam junto, pelo delta da duração.
 *
 * Título não tem velocidade (não é mídia): é não-evento.
 */
export function setClipSpeed(tl: Timeline, id: string, speed: number): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const { clip, track, ti } = loc;
  if (!isMedia(clip)) return tl;
  // 0.25..4: fora disso o `atempo` do áudio precisaria de correntes longas e o
  // resultado deixa de ser útil (fica irreconhecível). É a faixa dos NLEs.
  const sp = Math.max(0.25, Math.min(4, speed));
  const oldDur = clipDuration(clip);
  // A fonte consumida (invariante) vem da velocidade ATUAL, não da nova.
  const srcWin = oldDur * clipSpeed(clip);
  const newDur = Math.max(1, Math.round(srcWin / sp));
  if (newDur === oldDur && clipSpeed(clip) === sp) return tl;
  const delta = newDur - oldDur;
  const oldEnd = clipEnd(clip);
  const clips = track.clips.map((c) => {
    if (c.id === id) return { ...c, speed: sp, durationMs: newDur };
    // Vizinhos que começavam em/depois do fim ANTIGO deste clipe andam junto.
    if (c.startMs >= oldEnd) return { ...c, startMs: Math.max(0, c.startMs + delta) };
    return c;
  });
  return withTrack(tl, ti, clips);
}

/**
 * Define a transição (crossfade) entre este clipe e o SEGUINTE da trilha, em ms.
 * Como a transição é a SOBREPOSIÇÃO, mexer nela move o clipe seguinte pra dentro
 * (ou pra fora) deste. O valor é grampeado pra não passar da duração de nenhum
 * dos dois nem virar negativo.
 */
export function setTransition(tl: Timeline, id: string, transitionMs: number): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const { track, ci, ti } = loc;
  const a = track.clips[ci];
  const b = track.clips[ci + 1];
  if (!b) return tl;
  const want = Math.max(0, Math.min(Math.round(transitionMs), clipDuration(a), clipDuration(b)));
  // A sobreposição desejada: o seguinte começa em (fim de A − transição).
  const newStart = clipEnd(a) - want;
  if (newStart === b.startMs) return tl;
  const clips = track.clips.slice();
  clips[ci + 1] = { ...b, startMs: Math.max(0, newStart) };
  return withTrack(tl, ti, clips);
}

/* ------------------------------------------------------------------ */
/* Undo / redo (histórico de ESTADOS, genérico)                        */
/* ------------------------------------------------------------------ */

/**
 * Histórico de ESTADOS (não de comandos). Cabe porque uma timeline é uma árvore
 * rasa de objetinhos: guardar 200 retratos custa pouco, e retrato não tem como
 * "desfazer errado" — o inverso de um comando, tem. Editor sem undo não é
 * produto: é o requisito, não um extra.
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

/** Empurra um novo estado. Não-evento (mesma referência) não mexe no histórico:
 *  senão o Ctrl+Z gastaria passos desfazendo nada. */
export function pushHistory<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  const past = [...h.past, h.present].slice(-HISTORY_LIMIT);
  // Editar depois de desfazer queima o futuro — contrato de todo editor.
  return { past, present: next, future: [] };
}

/**
 * Troca o presente SEM mexer no passado nem no futuro. Existe pro arrasto
 * contínuo (aparar/mover pela alça): o `pointermove` dispara dezenas de vezes
 * por segundo; empilhar cada um faria "um arrasto = segurar Ctrl+Z" e ainda
 * comeria as vagas do histórico, empurrando pra fora os cortes DE VERDADE.
 * Quem arrasta empilha UMA vez (no 1º movimento) e daí só troca o presente.
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
