/**
 * A mixagem de áudio da PRÉVIA — a parte PURA e testável.
 *
 * ─── O buraco que sobrou ─────────────────────────────────────────────────────
 *
 * O `<video>` da prévia toca só o áudio da TRILHA BASE. Uma 2ª trilha (música de
 * fundo, narração) só se ouvia depois de exportar — o usuário montava a mixagem
 * às cegas. Este módulo responde, pra um instante `t`, QUAIS clipes de áudio das
 * OUTRAS trilhas tocam e com que GANHO — o `Preview` pega essa lista e conduz um
 * `<audio>` por clipe, em sincronia com o playhead. Assim dá pra ouvir a mistura
 * antes de exportar.
 *
 * A base fica de fora de propósito: o áudio dela já sai pelo `<video>`. Somar um
 * `<audio>` por cima dobraria o som da base.
 *
 * ─── O que é fiel e o que é aproximado (honestidade) ─────────────────────────
 *
 * FIEL ao export: volume constante, envelope de volume (keyframes) e fade in/out
 * explícitos — a mesma conta que o compilador manda pro `volume`/`afade`.
 *
 * APROXIMADO: (1) ganho > 1 (amplificar) não sobe na prévia — o `HTMLAudio` não
 * passa de volume 1.0; o export amplifica de verdade. (2) O crossfade de áudio
 * por SOBREPOSIÇÃO (o `acrossfade` do export) não é reproduzido aqui: dois
 * clipes que se cruzam tocam cada um com o seu ganho. Música de fundo raramente
 * se sobrepõe, então o caso comum sai certo; o export continua sendo o fiel.
 */

import { envelopeAt } from "./compose";
import { clipDuration, clipEnd, clipSpeed, isMedia, type Clip, type Timeline } from "./timeline";

/** Um clipe de áudio tocando em `t`, com onde-no-arquivo e ganho já resolvidos. */
export interface AudioLayer {
  /** Id do clipe — chaveia o `<audio>` que o toca (estável a re-render). */
  clipId: string;
  path: string;
  /** Instante DENTRO do arquivo-fonte (ms), considerando a velocidade. */
  srcTimeMs: number;
  /** Ganho linear 0..1 (volume × envelope × fades). Preso em 1 — ver cabeçalho. */
  gain: number;
}

/**
 * O ganho linear de um clipe de áudio no instante `t` da timeline. Espelha o
 * export: envelope de volume tem precedência sobre volume constante, e os fades
 * in/out (lineares, como o `afade` padrão) multiplicam por cima. Preso em 0..1.
 */
export function audioGainAt(clip: Clip, t: number): number {
  const dur = clipDuration(clip);
  const frac = dur > 0 ? (t - clip.startMs) / dur : 0;

  let g: number;
  if (clip.volumeKeyframes && clip.volumeKeyframes.length > 0) {
    g = envelopeAt(clip.volumeKeyframes, frac);
  } else {
    g = clip.volume ?? 1;
  }

  // Fades explícitos: rampa linear nas pontas (ms desde o início / até o fim).
  const into = t - clip.startMs;
  const untilEnd = clipEnd(clip) - t;
  if (clip.fadeInMs && clip.fadeInMs > 0) g *= Math.max(0, Math.min(1, into / clip.fadeInMs));
  if (clip.fadeOutMs && clip.fadeOutMs > 0) g *= Math.max(0, Math.min(1, untilEnd / clip.fadeOutMs));

  // O `<audio>` não amplifica além de 1.0 — preso aqui (o export sobe de verdade).
  return Math.max(0, Math.min(1, g));
}

/**
 * As camadas de áudio que tocam em `t`, de TODAS as trilhas menos a base (cujo
 * som já sai pelo `<video>`). Pula clipe mudo, título e buraco.
 */
export function audioLayersAt(tl: Timeline, t: number, baseTrackId: string | null): AudioLayer[] {
  const out: AudioLayer[] = [];
  for (const track of tl.tracks) {
    if (track.id === baseTrackId) continue; // a base é do <video>
    for (const c of track.clips) {
      if (!isMedia(c) || c.muted) continue;
      if (t < c.startMs || t >= clipEnd(c)) continue;
      out.push({
        clipId: c.id,
        path: c.path!,
        srcTimeMs: (c.srcIn ?? 0) + (t - c.startMs) * clipSpeed(c),
        gain: audioGainAt(c, t),
      });
    }
  }
  return out;
}

/** Há QUALQUER áudio de mix (fora da base) na timeline? A UI usa isto pra avisar
 *  que a prévia agora mistura as trilhas (e pra não montar o motor à toa). */
export function hasMixAudio(tl: Timeline, baseTrackId: string | null): boolean {
  return tl.tracks.some(
    (tk) => tk.id !== baseTrackId && tk.clips.some((c) => isMedia(c) && !c.muted),
  );
}

/**
 * Há algum clipe pedindo uma faixa de áudio que NÃO é a primeira do arquivo?
 *
 * ─── O limite que a prévia não tem como vencer ───────────────────────────────
 *
 * Um take do LocalRecord em "faixas separadas" traz duas faixas de áudio no
 * mesmo arquivo (Microfone e Áudio do sistema). O EXPORT separa as duas
 * corretamente — o compilador endereça cada uma por `[i:a:N]` no ffmpeg. A
 * PRÉVIA não consegue: quem toca som aqui é o `<video>`/`<audio>` do webview, e
 * **`HTMLMediaElement.audioTracks` não existe no Chromium** (medido no motor do
 * WebView2: `'audioTracks' in document.createElement('video') === false`). Sem
 * essa API não há como dizer ao elemento "toque a faixa 2" — ele toca a padrão,
 * sempre. Resultado: dois clipes destacados do mesmo arquivo soam IGUAIS na
 * prévia, embora saiam certos no arquivo exportado.
 *
 * Tocar a faixa certa exigiria extrair cada uma pra um arquivo temporário no
 * momento do detach (comando novo no Rust, cache em disco, espera no import) —
 * é uma fatia inteira, não um conserto. Enquanto ela não vem, a regra da casa
 * manda DIZER: esta função é o gatilho do aviso na barra da prévia. Fingir que
 * a prévia separa seria pior que o bug.
 */
export function usesNonDefaultAudioTrack(tl: Timeline): boolean {
  return tl.tracks.some((tk) =>
    tk.clips.some((c) => isMedia(c) && !c.muted && (c.audioStreamIndex ?? 0) > 0),
  );
}
