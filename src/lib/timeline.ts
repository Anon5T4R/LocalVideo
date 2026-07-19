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

/** Versão do formato `.tvproj`.
 *
 *  **3** desde a v0.9.1 (trilha com `muted`). Subiu de propósito, mesmo o campo
 *  sendo opcional: sem o bump um app ANTIGO abria o projeto novo, ignorava o
 *  mudo e — o problema de verdade — **descartava o campo ao salvar, calado**.
 *  Perda silenciosa de trabalho é pior que recusa explícita: com o bump o app
 *  antigo diz "projeto de versão mais nova" e o usuário sabe o que fazer.
 *  Decisão do João em 2026-07-19 ("não tem problema perder a retrocompat dessa
 *  vez"), possível porque a suíte tem um usuário só e ele atualiza tudo. */
export const TIMELINE_VERSION = 3;

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
 * O TIPO da transição com o próximo clipe (v0.4.1). A GEOMETRIA da transição
 * continua sendo a sobreposição (`startMs`/`durationMs` — ver o cabeçalho); o
 * tipo só diz COMO o clipe de cima entra durante ela:
 * - `dissolve` (o padrão de sempre): fade no canal alfa — o dissolve da v0.2.
 * - `wipe`: uma cortina revela o clipe novo da esquerda pra direita.
 * - `slide`: o clipe novo desliza inteiro da esquerda por cima do antigo.
 * Mora no clipe DE TRÁS ("a transição com o próximo") porque é nele que vive a
 * alça de transição da régua — o campo e o gesto apontam pro mesmo lugar.
 * Sem sobreposição, o campo é inerte (não muda nada no export nem na prévia).
 */
export type TransitionKind = "dissolve" | "wipe" | "slide";

/**
 * A DIREÇÃO de um wipe/slide (v0.9.2) — para onde a cortina varre, ou de onde o
 * clipe novo entra deslizando. Lê-se "de → para": `lr` = da esquerda pra
 * direita, `bt` = de baixo pra cima.
 *
 * ─── Por que campo PRÓPRIO, e não valores novos de `TransitionKind` ──────────
 *
 * O caminho óbvio seria `"wipeup" | "wipedown" | …` (é como o `xfade` do ffmpeg
 * nomeia). Foi descartado por causa do que acontece num app ANTIGO abrindo um
 * projeto novo: o parser do `.tvproj` só aceita valores conhecidos de
 * `transitionKind` e DESCARTA o resto (ver `project.ts`), então `"wipeup"`
 * viraria ausência — ou seja, o wipe do usuário viraria um **dissolve**. Trocar
 * o tipo da transição é uma mudança que se vê no vídeo exportado.
 *
 * Com a direção num campo separado, o app antigo ignora a chave desconhecida e
 * mantém `transitionKind: "wipe"`: continua sendo um wipe, só na direção padrão.
 * Degrada no eixo certo — e por isso esta fatia **não precisa de bump** do
 * `TIMELINE_VERSION` (que a v0.9.1 subiu pra 3).
 *
 * Ausente = `lr`, que era o único comportamento possível até aqui.
 */
export type TransitionDir = "lr" | "rl" | "tb" | "bt";

/** Todas as direções, na ordem em que o seletor as oferece. */
export const TRANSITION_DIRS: TransitionDir[] = ["lr", "rl", "tb", "bt"];

/** A direção de um clipe, com o padrão histórico. Num lugar só porque o
 *  compilador, a prévia e o inspetor têm que concordar no que é "ausente". */
export function transitionDir(c: Pick<Clip, "transitionDir">): TransitionDir {
  return c.transitionDir ?? "lr";
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
  /** QUAL faixa de áudio do arquivo-fonte este clipe usa (o `a:N` do ffmpeg).
   *  `undefined` = a primeira (0). Existe porque um take do LocalRecord traz
   *  microfone (0) e áudio do sistema (1) em faixas separadas — sem isto o
   *  export mandava `[idx:a]` cru, que num arquivo de duas faixas é AMBÍGUO: o
   *  ffmpeg pegava só a primeira e a segunda sumia do vídeo, calada. */
  audioStreamIndex?: number;
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

  /* --- transição (v0.4.1) --- */
  /** COMO o próximo clipe entra na sobreposição com este. Ausente = dissolve. */
  transitionKind?: TransitionKind;
  /** Pra ONDE varre/desliza (v0.9.2). Ausente = `lr`. Inerte no dissolve. */
  transitionDir?: TransitionDir;
}

/** Uma trilha: clipes ORDENADOS por `startMs`. Vídeo empilha (overlay/z-order);
 *  áudio mixa. */
export interface Track {
  id: string;
  kind: TrackKind;
  clips: Clip[];
  /**
   * Trilha SILENCIADA: o som dela não toca na prévia nem sai no arquivo final.
   *
   * Mora na TRILHA e não em cada clipe porque é interruptor de CAMADA — "tirar a
   * música de fundo pra ouvir a narração" é um clique, não uma passada por vinte
   * clipes (e desfazer isso clipe a clipe perderia quais já estavam mudos). O
   * `Clip.muted` continua existindo e é ortogonal: o clipe cala por si; a trilha
   * cala todo mundo por cima. Silenciar uma trilha de VÍDEO não some com a
   * imagem — mudo aqui é sobre som, como no `Clip.muted`.
   *
   * Ausente = toca (é o que todo projeto salvo antes da v0.9 diz, por omissão).
   */
  muted?: boolean;
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

/**
 * Insere um clipe de mídia numa trilha e num instante ESCOLHIDOS — o que o
 * arrasto do painel de mídia (v0.11) faz ao soltar: a posição é onde o dedo
 * soltou, a trilha é a lane debaixo dele.
 *
 * Irmã do `appendMedia`, e as duas continuam existindo porque respondem a
 * perguntas diferentes: o import rápido não sabe onde o usuário quer o clipe
 * (então enfileira no fim, sem buraco), e o arrasto sabe exatamente (então
 * obedece). Compartilhar as duas num único "insert com start opcional" faria a
 * regra do fim-da-trilha virar um `if` escondido dentro do caminho do arrasto.
 *
 * NÃO empurra ninguém: solta onde mandaram, sobrepondo se for o caso — é o
 * mesmo contrato do `moveClip`, e é o que o olho espera de um arrasto (o clipe
 * fica onde o dedo largou). Sobreposição em trilha de vídeo VIRA transição neste
 * modelo, o que é surpresa possível; mas a alternativa (empurrar os vizinhos)
 * seria surpresa CERTA — o filme inteiro andando por causa de um arrasto.
 *
 * Aceita trilha de áudio de propósito: soltar um arquivo direto numa lane de
 * áudio é o gesto de quem quer só a música, e o `detachAudio` já provou que um
 * clipe de mídia em trilha de áudio é cidadão de primeira classe aqui.
 */
export function insertMediaAt(
  tl: Timeline,
  trackId: string,
  startMs: number,
  media: { path: string; srcIn: number; srcOut: number },
): Timeline {
  const ti = tl.tracks.findIndex((t) => t.id === trackId);
  if (ti < 0) return tl;
  const durationMs = Math.max(0, Math.round(media.srcOut - media.srcIn));
  // Duração zero não vira clipe: um clipe de 0ms é invisível na régua, não dá
  // pra selecionar e ainda assim conta no `clipCount` — um fantasma.
  if (durationMs <= 0) return tl;
  const clip: Clip = {
    id: newId(),
    startMs: Math.max(0, Math.round(startMs)),
    durationMs,
    path: media.path,
    srcIn: Math.max(0, Math.round(media.srcIn)),
  };
  return withTrack(tl, ti, [...tl.tracks[ti].clips, clip]);
}

/**
 * Quantos clipes (em TODAS as trilhas) usam este arquivo.
 *
 * É a pergunta que o painel de mídia faz duas vezes: pra mostrar o contador no
 * item ("em uso: 3") e pra decidir se remover do pool precisa de confirmação.
 * Pura porque a resposta tem que ser a mesma nos dois lugares — um contador que
 * discorde do diálogo é como o app perde a confiança do usuário.
 */
export function mediaUsageCount(tl: Timeline, path: string): number {
  let n = 0;
  for (const t of tl.tracks) for (const c of t.clips) if (c.path === path) n += 1;
  return n;
}

/** Separa o áudio de um clipe de vídeo pra uma trilha de áudio própria.
 *
 *  O clipe de vídeo original fica MUDO (não perde o áudio — só para de tocá-lo),
 *  e nasce um clipe de áudio no mesmo lugar do tempo, apontando pro mesmo
 *  arquivo e pra mesma faixa. A partir daí dá pra mover, cortar ou ajustar o
 *  volume do áudio sem tocar no vídeo — o pedido de "separar áudio do vídeo".
 *
 *  `audioTrackCount` vem do `MediaInfo` do arquivo (o store tem): com faixas
 *  separadas (mic + sistema), cada uma vira um clipe de áudio próprio, cada um
 *  com seu `audioStreamIndex`. Assim o take do LocalRecord de duas faixas abre
 *  em duas trilhas editáveis, em vez de uma faixa colada no vídeo.
 *
 *  Função pura e sem efeito colateral: já mudo, ou sem áudio, devolve `tl` igual.
 */
export function detachAudio(tl: Timeline, id: string, audioTrackCount: number): Timeline {
  const loc = locate(tl, id);
  if (!loc || !isMedia(loc.clip) || loc.clip.muted) return tl;
  const { clip } = loc;
  const n = Math.max(1, audioTrackCount);
  const end = clipEnd(clip);

  // O vídeo cala — o áudio não some, só para de tocar por ele.
  let out: Timeline = updateClip(tl, id, { muted: true });

  // Cada faixa-fonte vira um clipe de áudio próprio. Faixas separadas (mic +
  // sistema) coexistem no MESMO trecho de tempo, então cada uma precisa da sua
  // trilha — senão se sobreporiam e virariam crossfade sem querer. Reusa uma
  // trilha de áudio livre naquele intervalo antes de criar outra (o
  // `newTimeline` já traz uma vazia; empilhar por cima dela sujaria a lista).
  for (let k = 0; k < n; k++) {
    const aclip: Clip = {
      id: newId(),
      startMs: clip.startMs,
      durationMs: clip.durationMs,
      path: clip.path,
      srcIn: clip.srcIn ?? 0,
      speed: clip.speed,
      audioStreamIndex: k,
    };
    const ti = out.tracks.findIndex(
      (t) => t.kind === "audio" && t.clips.every((c) => c.startMs >= end || clipEnd(c) <= clip.startMs),
    );
    if (ti >= 0) {
      out = withTrack(out, ti, [...out.tracks[ti].clips, aclip]);
    } else {
      out = { ...out, tracks: [...out.tracks, { id: newId("at"), kind: "audio", clips: [aclip] }] };
    }
  }
  return out;
}

/** Adiciona uma trilha (vídeo empilha por cima; áudio mixa). */
export function addTrack(tl: Timeline, kind: TrackKind): Timeline {
  return { ...tl, tracks: [...tl.tracks, { id: newId(kind === "video" ? "vt" : "at"), kind, clips: [] }] };
}

/**
 * Liga/desliga o mudo de uma trilha inteira (ver `Track.muted`). Puro e
 * não-evento quando já está no estado pedido — assim o Ctrl+Z não gasta passo
 * clicando duas vezes no mesmo botão.
 *
 * `false` REMOVE a chave em vez de gravar `muted: false`: um projeto que nunca
 * silenciou nada não deve ganhar um campo novo em toda trilha só por ter passado
 * pela v0.9 (e é o que mantém o `.tvproj` legível e o diff de um save honesto).
 */
export function setTrackMuted(tl: Timeline, trackId: string, muted: boolean): Timeline {
  const ti = tl.tracks.findIndex((t) => t.id === trackId);
  if (ti < 0) return tl;
  const cur = tl.tracks[ti].muted ?? false;
  if (cur === muted) return tl;
  const tracks = tl.tracks.slice();
  if (muted) {
    tracks[ti] = { ...tracks[ti], muted: true };
  } else {
    const { muted: _drop, ...rest } = tracks[ti];
    tracks[ti] = rest;
  }
  return { ...tl, tracks };
}

/**
 * Dá pra remover esta trilha?
 *
 * A única trava é estrutural: **tem que sobrar ao menos uma trilha de vídeo**.
 * Não é preciosismo — `baseVideoTrack` é a âncora de três coisas (a prévia lê
 * dela, o import solta o clipe nela, o título nasce nela) e o `parseProject`
 * RECUSA um `.tvproj` sem trilha de vídeo. Uma timeline sem vídeo seria um
 * projeto que o próprio app não consegue reabrir.
 *
 * Trilha de áudio não tem trava: dá pra ficar sem nenhuma (o `detachAudio` cria
 * uma quando precisa).
 */
export function canRemoveTrack(tl: Timeline, trackId: string): boolean {
  const track = tl.tracks.find((t) => t.id === trackId);
  if (!track) return false;
  if (track.kind !== "video") return true;
  return tl.tracks.filter((t) => t.kind === "video").length > 1;
}

/**
 * Remove uma trilha INTEIRA, com os clipes que estiverem nela. Quem confirma o
 * estrago (trilha não-vazia) é a UI — aqui é só a operação, e o undo cobre.
 *
 * Faltava desde sempre: depois de separar o áudio de um take de duas faixas o
 * usuário ficava com trilhas que não conseguia tirar de jeito nenhum — trilha
 * criada era pra sempre.
 */
export function removeTrack(tl: Timeline, trackId: string): Timeline {
  if (!canRemoveTrack(tl, trackId)) return tl;
  return { ...tl, tracks: tl.tracks.filter((t) => t.id !== trackId) };
}

/**
 * Troca uma trilha de lugar com a vizinha DO MESMO TIPO (`dir` −1 = pra cima).
 *
 * Do mesmo tipo porque a ordem só significa alguma coisa dentro do tipo: entre
 * as de vídeo ela é a z-order do overlay (quem está por cima de quem); entre as
 * de áudio o mix é comutativo e a ordem é só arrumação da tela. Um ↑ que
 * atravessasse um bloco pro outro faria a lista dançar sem mudar nada no filme.
 *
 * **Consequência que a UI precisa deixar visível**: a primeira trilha de vídeo é
 * a BASE (ver `baseVideoTrack`) — subir uma V2 pro topo a torna a base, e com
 * isso a prévia passa a tocar o áudio dela e o import passa a soltar clipe nela.
 * É coerente com o rótulo (a que virar a primeira passa a se chamar V1), e é por
 * isso que o rótulo é derivado da ordem e não guardado.
 */
export function moveTrack(tl: Timeline, trackId: string, dir: -1 | 1): Timeline {
  const i = tl.tracks.findIndex((t) => t.id === trackId);
  if (i < 0) return tl;
  const kind = tl.tracks[i].kind;
  let j = -1;
  for (let k = i + dir; k >= 0 && k < tl.tracks.length; k += dir) {
    if (tl.tracks[k].kind === kind) {
      j = k;
      break;
    }
  }
  if (j < 0) return tl;
  const tracks = tl.tracks.slice();
  [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  return { ...tl, tracks };
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

/** Props de um clipe de LEGENDA: um título ancorado embaixo, menor que um
 *  título de abertura. Fonte própria porque legenda e título têm tamanhos
 *  diferentes por natureza — daí ser uma função e não `defaultTitle`. */
export function subtitleProps(text: string): TitleProps {
  return { text, fontSizePx: 32, color: "#ffffff", anchor: "bottom" };
}

/** Insere legendas como clipes de título numa trilha de vídeo por cima.
 *
 *  Cada cue vira um clipe com seu tempo próprio — e como legenda É um clipe de
 *  título aqui, o inspetor já sabe editá-la (texto, fonte, âncora) e o export já
 *  sabe queimá-la (`drawtext`). O trabalho de importar é só POSICIONAR.
 *
 *  Vão todas numa trilha nova, no topo: assim ficam por cima do vídeo e o
 *  usuário liga/desliga a camada inteira movendo/removendo a trilha, sem caçar
 *  clipe por clipe. Cues que se sobreporiam no tempo (raro, mas legenda ruim
 *  existe) são aparados pra não virar crossfade sem querer. */
export function addSubtitles(
  tl: Timeline,
  cues: { startMs: number; durationMs: number; text: string }[],
): Timeline {
  if (cues.length === 0) return tl;
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
  const clips: Clip[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const cue = ordered[i];
    const next = ordered[i + 1];
    // Não deixa uma legenda invadir a próxima: se a duração do arquivo passar do
    // início da seguinte, encurta. Na mesma trilha isso viraria sobreposição.
    const cap = next ? next.startMs - cue.startMs : cue.durationMs;
    clips.push({
      id: newId("sub"),
      startMs: Math.max(0, Math.round(cue.startMs)),
      durationMs: Math.max(100, Math.round(Math.min(cue.durationMs, cap))),
      title: subtitleProps(cue.text),
    });
  }
  return { ...tl, tracks: [...tl.tracks, { id: newId("vt"), kind: "video", clips }] };
}

/* ------------------------------------------------------------------ */
/* Edição (puro; devolve a MESMA referência quando é não-evento)       */
/* ------------------------------------------------------------------ */

/**
 * Corta um clipe no instante `at` da timeline, virando um em dois. Não é erro
 * cortar onde não dá (na borda, no vazio) — é não-evento, e devolve a MESMA
 * timeline (assim o `S` nunca "dá erro" e o undo não empilha lixo).
 */
/**
 * QUAL clipe o "S" corta. Puro porque é a regra, não o efeito — e porque foi
 * justamente ela que estava errada.
 *
 * Até a v0.7 o `doSplit` perguntava sempre à TRILHA BASE (`baseVideoTrack`):
 * selecionar um clipe em V2 ou numa trilha de áudio (por exemplo o áudio recém-
 * separado de um take de duas faixas) e apertar S cortava... o vídeo lá de
 * baixo, ou nada. O atalho mais usado de um NLE ignorava a seleção.
 *
 * A regra nova é a de todo NLE: corta o clipe SELECIONADO, desde que o playhead
 * esteja dentro dele (fora, não há o que cortar naquele clipe). Sem seleção — ou
 * com a seleção fora do playhead — cai no comportamento antigo, a trilha base,
 * pra quem só aperta S enquanto assiste não perder nada.
 */
export function splitTargetId(tl: Timeline, selectedId: string | null, at: number): string | null {
  if (selectedId) {
    const loc = locate(tl, selectedId);
    // Título também corta: `splitAt` já sabe dividir os dois (só a mídia ganha
    // `srcIn` novo). O que ele NÃO faz é cortar em cima da borda — e aí a
    // condição abaixo já barra antes.
    if (loc && at > loc.clip.startMs && at < clipEnd(loc.clip)) return selectedId;
  }
  return timeToClip(baseVideoTrack(tl), at)?.clip.id ?? null;
}

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
 *
 * **Ripple** (`ripple = true`): aparar não deixa mais buraco — os vizinhos à
 * frente na MESMA trilha andam junto, mantendo a fila colada. É o que separa um
 * NLE de um cortador de vídeo. As duas bordas têm regra própria (ver abaixo);
 * ambas preservam a adjacência sem inventar sobreposição.
 */
export function setClipEdge(
  tl: Timeline,
  id: string,
  edge: "in" | "out",
  timelineMs: number,
  srcLimit?: number,
  ripple = false,
): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const { clip, ti } = loc;
  const end = clipEnd(clip);
  const oldEnd = end;
  const media = isMedia(clip);
  // Com velocidade, 1 ms de borda anda `speed` ms na fonte — os limites de fonte
  // (srcIn≥0, srcOut≤arquivo) viram limites de tempo de timeline dividindo por
  // `speed`.
  const sp = clipSpeed(clip);
  let next: Clip;
  // Quanto os vizinhos com `startMs >= oldEnd` deslocam (só no ripple).
  let shiftBy = 0;

  if (edge === "in") {
    if (ripple) {
      // Ripple na borda IN: mantém o START colado (não abre buraco ANTES), apara
      // a CABEÇA (avança `srcIn` e encurta) e PUXA a cauda pelo tanto que o clipe
      // encurtou. O `srcOut` é preservado — só o miolo visível do começo muda —
      // e nada fica boiando. `headDelta > 0` corta cabeça; `< 0` devolve cabeça.
      const maxHead = clipDuration(clip) - 1; // deixa ≥ 1 ms de clipe
      const minHead = media ? -((clip.srcIn ?? 0) / sp) : Number.NEGATIVE_INFINITY; // srcIn ≥ 0
      const headDelta = Math.round(Math.max(minHead, Math.min(timelineMs - clip.startMs, maxHead)));
      if (headDelta === 0) return tl;
      next = {
        ...clip,
        durationMs: clipDuration(clip) - headDelta,
        ...(media ? { srcIn: Math.max(0, Math.round((clip.srcIn ?? 0) + headDelta * sp)) } : {}),
      };
      shiftBy = -headDelta;
    } else {
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
    }
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
    // Ripple na borda OUT: a fila à frente cola no novo fim (encurtou? sobe;
    // esticou? desce), sem buraco nem sobreposição.
    if (ripple) shiftBy = clip.startMs + newDur - oldEnd;
  }

  let clips = tl.tracks[ti].clips.slice();
  clips[loc.ci] = next;
  if (ripple && shiftBy !== 0) {
    clips = clips.map((c) =>
      c.id !== id && c.startMs >= oldEnd ? { ...c, startMs: Math.max(0, c.startMs + shiftBy) } : c,
    );
  }
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
 * Remove um clipe FECHANDO o buraco: os que vinham depois dele NA MESMA TRILHA
 * andam pra trás o tamanho do que saiu. É o "ripple delete" de qualquer NLE.
 *
 * O buraco não é detalhe estético: com o modo Ripple LIGADO o aparar já puxava
 * os vizinhos, mas o `Del` continuava deixando um vazio preto no meio do filme —
 * duas ferramentas com a mesma promessa e comportamentos opostos, o que ensina o
 * usuário a não confiar no interruptor. Aqui o `Del` passa a honrar o modo.
 *
 * Só a trilha do clipe se move: puxar as OUTRAS trilhas junto dessincronizaria a
 * música de fundo do vídeo (o ripple global é outra ferramenta, e nem todo NLE a
 * liga por padrão). Clipes que começam ANTES do removido ficam parados — o
 * deslocamento é sempre pra quem vinha depois.
 */
export function removeClipRipple(tl: Timeline, id: string): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const gone = loc.clip;
  const shift = clipDuration(gone);
  const clips = loc.track.clips
    .filter((c) => c.id !== id)
    // `>=` e não `>`: um clipe que começa EXATAMENTE onde o removido começava
    // (sobreposto por crossfade) também vinha "depois" na fila e tem que subir.
    .map((c) => (c.startMs >= gone.startMs ? { ...c, startMs: Math.max(0, c.startMs - shift) } : c));
  return withTrack(tl, loc.ti, clips);
}

/**
 * Duplica um clipe, pondo a cópia LOGO DEPOIS do original, na mesma trilha, e
 * empurrando pra frente quem vinha atrás — o Ctrl+D que faltava.
 *
 * Empurrar (em vez de sobrepor) é deliberado: uma cópia caindo por cima do
 * vizinho viraria um crossfade que ninguém pediu (a sobreposição É a transição
 * neste modelo), e o usuário levaria um efeito de brinde sem saber de onde veio.
 * Empurrando, o resultado é o que o olho espera: o mesmo trecho, duas vezes.
 *
 * A cópia leva TUDO menos a identidade: mesma janela-fonte, volume, fades,
 * filtros, velocidade, faixa de áudio. `newId()` garante que os dois nunca se
 * confundam no `locate` (ids iguais fariam a seleção e o arrasto pegarem o
 * errado).
 */
export function duplicateClip(tl: Timeline, id: string): Timeline {
  const loc = locate(tl, id);
  if (!loc) return tl;
  const src = loc.clip;
  const dur = clipDuration(src);
  if (dur <= 0) return tl;
  const at = clipEnd(src);
  const copy: Clip = { ...src, id: newId(isTitle(src) ? "t" : "c"), startMs: at };
  const clips = loc.track.clips.map((c) =>
    c.id !== id && c.startMs >= at ? { ...c, startMs: c.startMs + dur } : c,
  );
  return withTrack(tl, loc.ti, [...clips, copy]);
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
