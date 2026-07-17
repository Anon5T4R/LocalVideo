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
  streamCount: number;
  sizeBytes: number;
}

/** O que o app usa: o cru + o fps já convertido. */
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

/** Anda `frames` quadros a partir de `t` (setas), sem sair de `0..max`. */
export function stepFrames(t: number, frames: number, fps: number, max: number): number {
  const next = t + frames * frameMs(fps);
  return Math.max(0, Math.min(Math.round(next), Math.round(max)));
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

/** `00:01:02:14` — timecode com QUADRO (o playhead; é o que NLE mostra). */
export function formatTimecode(ms: number, fps: number): string {
  const f = fps > 0 ? fps : FALLBACK_FPS;
  const total = Math.max(0, ms);
  const frame = Math.floor((total % 1000) / frameMs(f));
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
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
