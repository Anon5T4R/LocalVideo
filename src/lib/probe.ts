/**
 * Ler o que o ffprobe disse, e a matemática de tempo que a régua/atalhos usam.
 * TS puro (testado): o Rust só roda o binário e entrega os campos crus.
 */

/** Espelho do `MediaInfo` do `src-tauri/src/media.rs` (serde camelCase). */
export interface RawMediaInfo {
  path: string;
  durationMs: number;
  width: number;
  height: number;
  /** Fração CRUA do ffprobe: "30000/1001", "25/1", às vezes "0/0". */
  frameRate: string;
  avgFrameRate: string;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  /** TODAS as faixas de áudio do arquivo, em ordem, com o índice REAL do stream.
   *  Um take do LocalRecord com faixas separadas traz duas (mic + sistema) —
   *  antes o app via só a primeira e a segunda sumia na importação. */
  audioTracks: AudioTrackInfo[];
  /** Legendas EMBUTIDAS no container (srt/mov_text). Opcional porque um
   *  `.tvproj` salvo antes desta versão não traz o campo — leia com `?? []`. */
  subtitleTracks?: SubtitleTrackInfo[];
  streamCount: number;
  sizeBytes: number;
}

/** Uma faixa de legenda embutida (espelha `SubtitleStreamInfo` do Rust). */
export interface SubtitleTrackInfo {
  /** Índice ORDINAL entre as legendas — o `s:N` do `-map 0:s:N` da extração. */
  index: number;
  codec: string;
  title: string | null;
  language: string | null;
}

/** Nome de EXIBIÇÃO de uma faixa (áudio ou legenda): o título que veio no
 *  arquivo, senão o idioma, senão `null` — e aí a UI mostra "Faixa N"
 *  (`t("track.n")`), nunca um campo vazio. Num lugar só porque o inspetor, o
 *  menu de contexto e o rótulo do clipe têm que concordar no nome. */
export function trackDisplayName(tk: { title: string | null; language: string | null }): string | null {
  return tk.title ?? tk.language ?? null;
}

/**
 * A faixa de áudio de ORDINAL `n` — e o motivo desta função existir em vez de um
 * `.find(a => a.index === n)` espalhado pela UI.
 *
 * **São dois espaços de índice diferentes, e a UI misturava os dois** (o bug do
 * "as faixas separadas parecem iguais"):
 *
 * - `AudioTrackInfo.index` é o índice do stream NO CONTAINER. Num arquivo do
 *   LocalRecord (`vídeo, áudio, áudio`) as duas faixas são os streams **1 e 2**.
 * - `Clip.audioStreamIndex` é o ORDINAL ENTRE OS ÁUDIOS — o `N` do `[i:a:N]`
 *   que o compilador escreve (`lib/args.ts`). As mesmas duas faixas são **0 e 1**.
 *
 * O `detachAudio` grava 0 e 1 (certo pro export, provado com os tons de teste),
 * mas o seletor do inspetor listava as opções com `value={a.index}` (1 e 2) e a
 * régua procurava o nome por `a.index === audioStreamIndex`. Consequências
 * visíveis: nenhuma opção casava com o valor do clipe (o `<select>` mostrava
 * "Microfone" pros DOIS clipes), o clipe da faixa 0 ficava SEM etiqueta na régua
 * e o da faixa 1 recebia o nome da faixa errada — dois clipes indistinguíveis.
 * Pior: escolher "Microfone" no seletor gravava `audioStreamIndex = 1`, que no
 * export é a faixa do SISTEMA. Errado no arquivo final, calado.
 *
 * Um lugar só, então, pra converter ordinal → faixa: a posição no array. É essa
 * a ordem em que o Rust coleta os áudios, e é essa que o ffmpeg conta em `a:N`.
 */
export function audioTrackAt(tracks: AudioTrackInfo[], ordinal: number): AudioTrackInfo | undefined {
  return ordinal >= 0 ? tracks[ordinal] : undefined;
}

/** O que o app usa: o cru + o fps já convertido. */
/** Uma faixa de áudio dentro do arquivo (espelha `AudioStreamInfo` do Rust). */
export interface AudioTrackInfo {
  /** Índice do stream NO ARQUIVO — é ele que vai pro `-map`/`filter_complex`. */
  index: number;
  codec: string;
  channels: number;
  /** `title` da metadata: "Microfone", "Áudio do sistema". */
  title: string | null;
  language: string | null;
}

export interface MediaInfo extends RawMediaInfo {
  fps: number;
}

/**
 * Converte a taxa de quadros do ffprobe.
 *
 * O GOTCHA: **isto vem como fração**, não como número. `30000/1001` é o 29,97
 * do NTSC — quem faz `parseFloat("30000/1001")` recebe **30000** e a timeline
 * inteira vira pó (um quadro passa a "durar" 0,03 ms). `24000/1001` = 23,976,
 * `25/1` = PAL.
 *
 * Casos reais que caem aqui: `0/0` (stream sem taxa declarada — imagem, ou
 * VFR mal tageado) e `""` (campo ausente). Ambos ⇒ 0, e quem chama decide o
 * fallback; inventar 30 fps calado seria mentir sobre a mídia do usuário.
 */
export function parseFrameRate(s: string | null | undefined): number {
  if (!s) return 0;
  const txt = s.trim();
  const slash = txt.indexOf("/");
  if (slash < 0) {
    const n = Number(txt);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const num = Number(txt.slice(0, slash));
  const den = Number(txt.slice(slash + 1));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) return 0;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

/** Fps padrão quando o arquivo não declara — só pra grade dos atalhos de seta. */
export const FALLBACK_FPS = 30;

/** Imagens PARADAS aceitas como clipe (v0.14). `gif` fica DE FORA de propósito:
 *  é animado (tem duração real no ffprobe) e entra como vídeo normal — tratá-lo
 *  como imagem parada congelaria a animação. */
export const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "bmp"];

/** É um arquivo de imagem parada? (pela extensão — o probe do ffprobe também
 *  sonda imagem, mas quem decide o TIPO do clipe no import é a extensão.) */
export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT.includes(ext);
}

/**
 * Arquivos só-áudio aceitos como fonte.
 *
 * Não existiam até aqui, e a falta era invisível do jeito pior: o diálogo de
 * importar não os LISTAVA e o drop nativo os filtrava fora sem dizer nada, então
 * arrastar um mp3 pra dentro do app simplesmente não fazia nada — nem erro, nem
 * clipe. Com isso, "montar um vídeo a partir de um áudio" (foto + música, um
 * podcast com capa) era impossível, embora o compilador de export já soubesse
 * mixar trilha de áudio desde a v0.7.
 *
 * `.mp4` e `.mkv` NÃO entram aqui mesmo quando o arquivo só tem som: quem decide
 * a trilha de destino é a extensão, e um container de vídeo pode ganhar imagem
 * depois. Um arquivo assim entra como vídeo e o usuário separa o áudio — o
 * caminho que já existe.
 */
export const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "wma", "aiff"];

/** É um arquivo só-áudio? (pela extensão, mesma regra do `isImagePath`.) */
export function isAudioPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXT.includes(ext);
}

/**
 * Fps confiável do arquivo. Prefere `avg_frame_rate` (média REAL dos quadros);
 * o `r_frame_rate` é a menor taxa que expressa todos os timestamps e num vídeo
 * de taxa variável estoura pra coisas como 1000 fps — número certo pro
 * container, inútil pra passo de quadro.
 */
export function effectiveFps(info: RawMediaInfo): number {
  return parseFrameRate(info.avgFrameRate) || parseFrameRate(info.frameRate) || FALLBACK_FPS;
}

export function withFps(info: RawMediaInfo): MediaInfo {
  return { ...info, fps: effectiveFps(info) };
}

/** Duração de um quadro em ms. */
export function frameMs(fps: number): number {
  return fps > 0 ? 1000 / fps : 1000 / FALLBACK_FPS;
}

/**
 * Anda `frames` quadros a partir de `t` (setas), sem sair de `0..max`.
 *
 * **Anda pela GRADE de quadros, não somando ms cru.** Um quadro dura 33,367 ms
 * no NTSC (não um inteiro): somar isso ao playhead e arredondar a CADA passo
 * fazia o erro de arredondamento acumular — depois de dezenas de setas o
 * timecode saía de sincronia com o número de quadros andados (o "atraso de 1
 * quadro" relatado). Recuperar o índice do quadro mais próximo e somar mantém N
 * passos SEMPRE no quadro k+N, sem deriva (o casa com o `formatTimecode` abaixo).
 */
export function stepFrames(t: number, frames: number, fps: number, max: number): number {
  const fm = frameMs(fps);
  const curFrame = Math.round(t / fm);
  const next = (curFrame + frames) * fm;
  return Math.max(0, Math.min(Math.round(next), Math.round(max)));
}

/** Onde o playhead para depois de `dtMs` de RELÓGIO DE PAREDE correndo pelo
 *  vazio, e se o filme acabou nesse passo. */
export interface GapStep {
  /** Novo playhead, em ms (inteiro, preso em `0..total`). */
  playhead: number;
  /** Bateu no fim do filme? (o chamador pausa e crava no `total`.) */
  ended: boolean;
}

/**
 * Quanto o playhead anda num quadro de animação enquanto está num BURACO (sem
 * clipe embaixo). Diferente do play normal — ali quem manda o tempo é o
 * `<video>`; no vazio não há `<video>`, então o tempo tem que vir do relógio de
 * parede. `dtMs` é o tempo real desde o último quadro; `rate` a velocidade (só
 * faz sentido > 0 aqui — a ré tem o seu próprio ticker).
 *
 * Puro e testado porque É a conta do "correr pelo vazio": um NLE não pula o
 * buraco nem trava nele, ele deixa o tempo andar (tela preta) até o próximo
 * clipe ou o fim. Se o passo cruzaria o fim, prende no `total` e sinaliza o fim
 * — sem estourar pra além da duração do filme.
 */
export function gapAdvance(playhead: number, dtMs: number, rate: number, total: number): GapStep {
  const step = dtMs * (rate > 0 ? rate : 1);
  const next = playhead + step;
  if (next >= total) return { playhead: Math.round(total), ended: true };
  return { playhead: Math.max(0, Math.round(next)), ended: false };
}

/**
 * Instantes (ms) pra amostrar `count` miniaturas de um trecho.
 *
 * **Miolo de cada fatia, nunca as bordas.** Amostrar em 0 pega a tela preta da
 * abertura e no fim pega os créditos: a régua fica uma fileira de retângulos
 * pretos e não ajuda ninguém a achar a cena.
 */
export function thumbTimes(startMs: number, endMs: number, count: number): number[] {
  const n = Math.max(1, Math.min(Math.round(count), 400));
  const a = Math.max(0, Math.min(startMs, endMs));
  const b = Math.max(a, Math.max(startMs, endMs));
  const span = b - a;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round(a + (span * (2 * i + 1)) / (2 * n)));
  }
  return out;
}

/**
 * Índice da miniatura mais próxima do instante `t`.
 *
 * A régua é desenhada com a tira que já foi extraída do ARQUIVO INTEIRO no
 * import: assim cortar e aparar redesenha na hora, sem chamar o ffmpeg de novo.
 * A miniatura fica um tico fora do lugar em zoom alto — troca consciente:
 * miniatura aproximada agora vale mais que a exata daqui a três segundos.
 */
export function nearestThumb(times: number[], t: number): number {
  if (times.length === 0) return -1;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(times[i] - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** `1:04.3` / `1:02:03.5` — tempo que gente lê (a duração da timeline). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const tenths = Math.floor((total % 1000) / 100);
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}.${tenths}`;
}

/**
 * `+0:00.5` / `−0:01.2` / `0:00.0` — o DELTA de um arrasto (v0.9.2).
 *
 * O sinal é a informação principal (ganhou ou perdeu tempo?), então ele vem
 * primeiro e sempre: sem o `+` explícito, "0:00.5" não diz se o clipe andou pra
 * frente ou pra trás. O menos é o SINAL tipográfico `−` (U+2212), não o hífen —
 * é o mesmo que o fantasma do ripple já usa, e alinha na fonte tabular em vez de
 * virar um risquinho meio pixel mais alto que o `+`.
 *
 * Zero não leva sinal: "não mexeu" não é nem mais nem menos.
 */
export function formatDelta(ms: number): string {
  const r = Math.round(ms);
  if (r === 0) return formatDuration(0);
  return `${r > 0 ? "+" : "−"}${formatDuration(Math.abs(r))}`;
}

/** `00:01:02:14` — timecode com QUADRO (o playhead; é o que NLE mostra).
 *
 * Decompõe a partir do ÍNDICE TOTAL de quadros (arredondado), não de `ms%1000`.
 * O motivo é o mesmo do `stepFrames`: com quadro de 33,367 ms, `floor(33/33,367)`
 * dava `0` — o playhead andava um quadro e a tela continuava mostrando `:00`
 * (atraso de 1 quadro). Arredondar pro quadro mais próximo mostra o quadro certo,
 * e derivar h:m:s:f do índice total impede o resto de `%1000` de acumular erro ao
 * longo dos segundos. Timecode NÃO-DROP (fps arredondado pro inteiro), que é o
 * padrão de NLE pra taxas fracionárias (29,97 conta 30 quadros por segundo). */
export function formatTimecode(ms: number, fps: number): string {
  const f = fps > 0 ? fps : FALLBACK_FPS;
  const fpsInt = Math.max(1, Math.round(f));
  const totalFrames = Math.round(Math.max(0, ms) / frameMs(f));
  const frame = totalFrames % fpsInt;
  const totalSecs = Math.floor(totalFrames / fpsInt);
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(frame)}`;
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
