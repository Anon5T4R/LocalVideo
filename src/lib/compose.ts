/**
 * Composição da prévia (WYSIWYG) — a parte PURA e testável.
 *
 * ─── O buraco que a v0.2 deixou ──────────────────────────────────────────────
 *
 * Até a v0.2 a prévia mostrava só a TRILHA BASE. Overlay, PiP, título e
 * crossfade só apareciam depois de exportar — o usuário editava às cegas. A v0.3
 * fecha isso: a prévia COMPÕE a timeline ao vivo num canvas, e o que se vê é o
 * que se exporta.
 *
 * Este módulo não desenha nada (não conhece canvas nem WebCodecs). Ele responde
 * uma pergunta pura: **no instante `t`, quais camadas existem, em que ordem, e
 * com que opacidade/tempo-fonte?** O `Preview.tsx` pega essa lista, decodifica os
 * quadros e pinta. Separar assim deixa a matemática (crossfade, envelope de
 * opacidade) sob teste, longe da tela.
 *
 * A ORDEM importa e casa com o compilador (`filterComplexArgs`): trilhas de
 * baixo pra cima, clipes na ordem da trilha — o de cima cobre o de baixo, igual
 * ao `overlay` empilhado do export.
 */

import {
  clipDuration,
  clipEnd,
  clipSpeed,
  type Clip,
  type ColorAdjust,
  type Keyframe,
  type Timeline,
  type Track,
} from "./timeline";

/** Uma camada de mídia a desenhar (um clipe de vídeo tocando em `t`). */
export interface MediaLayer {
  kind: "media";
  clip: Clip;
  /** Instante DENTRO do arquivo-fonte (ms) — considera a velocidade. */
  srcTimeMs: number;
  /** Opacidade final (envelope/constante × crossfade), 0..1. */
  alpha: number;
  /** A cor (eq) não é reproduzível fielmente no canvas → prévia aproximada. */
  approx: boolean;
}

/** Uma camada de título (texto desenhado por cima). */
export interface TitleLayer {
  kind: "title";
  clip: Clip;
  alpha: number;
}

export type Layer = MediaLayer | TitleLayer;

/** Sobreposição (ms) entre dois clipes vizinhos de mídia. Igual ao do compilador
 *  e do modelo — local pra este módulo puro não depender da UI. */
function overlapMs(a: Clip, b: Clip): number {
  const ov = a.startMs + a.durationMs - b.startMs;
  return Math.max(0, Math.min(ov, a.durationMs, b.durationMs));
}

/**
 * Alfa do crossfade do clipe `i` no instante `t`. Durante a sobreposição com o
 * clipe de mídia anterior, o de cima ENTRA (0→1) — o de baixo continua desenhado
 * embaixo (ainda está ativo), e o olho vê o dissolve. Fora da sobreposição, 1.
 * Casa com o `fade=t=in:st=0:d=overlap:alpha=1` do export.
 */
export function crossfadeAlpha(track: Track, i: number, t: number): number {
  const c = track.clips[i];
  const prev = i > 0 ? track.clips[i - 1] : undefined;
  if (!prev || prev.path === undefined || c.path === undefined) return 1;
  const ov = overlapMs(prev, c);
  if (ov <= 0) return 1;
  if (t >= c.startMs + ov) return 1;
  return Math.max(0, Math.min(1, (t - c.startMs) / ov));
}

/**
 * Valor de um envelope no ponto `frac` (0..1 da duração do clipe). Interpolação
 * linear entre os pontos; fora das pontas, prende no primeiro/último. É o mesmo
 * envelope que o compilador manda pro ffmpeg (`envelopeExpr`) — aqui numérico
 * pra pintar o mesmo resultado na prévia.
 */
export function envelopeAt(kfs: Keyframe[], frac: number): number {
  const p = [...kfs].sort((a, b) => a.t - b.t);
  if (p.length === 0) return 1;
  if (frac <= p[0].t) return p[0].v;
  if (frac >= p[p.length - 1].t) return p[p.length - 1].v;
  for (let i = 0; i < p.length - 1; i++) {
    if (frac >= p[i].t && frac <= p[i + 1].t) {
      const span = p[i + 1].t - p[i].t;
      if (span <= 0) return p[i + 1].v;
      return p[i].v + ((p[i + 1].v - p[i].v) * (frac - p[i].t)) / span;
    }
  }
  return p[p.length - 1].v;
}

/**
 * Aproxima o `eq` do ffmpeg num `filter` de canvas. **É aproximação de propósito
 * e o app AVISA** (`approx`): o brilho do ffmpeg é ADITIVO e o do canvas é
 * multiplicativo — não casam pixel a pixel. Contraste e saturação são parecidos.
 * Bom pra sentir o ajuste na prévia; o export é que é fiel.
 */
export function colorToCanvasFilter(c: ColorAdjust): string {
  const brightness = Math.max(0, 1 + c.brightness).toFixed(3);
  return `brightness(${brightness}) contrast(${c.contrast.toFixed(3)}) saturate(${c.saturation.toFixed(3)})`;
}

/** Opacidade do clipe em `t` (envelope se houver, senão a constante). */
function opacityOf(c: Clip, t: number): number {
  if (c.opacityKeyframes && c.opacityKeyframes.length > 0) {
    const frac = clipDuration(c) > 0 ? (t - c.startMs) / clipDuration(c) : 0;
    return envelopeAt(c.opacityKeyframes, frac);
  }
  return c.opacity ?? 1;
}

/**
 * As camadas que existem no instante `t`, de baixo pra cima. Mídia e título de
 * TODAS as trilhas de vídeo, na ordem em que o export as empilha.
 */
export function layersAt(tl: Timeline, t: number): Layer[] {
  const out: Layer[] = [];
  for (const track of tl.tracks) {
    if (track.kind !== "video") continue;
    track.clips.forEach((c, i) => {
      if (t < c.startMs || t >= clipEnd(c)) return;
      if (c.path !== undefined) {
        const srcTimeMs = (c.srcIn ?? 0) + (t - c.startMs) * clipSpeed(c);
        const alpha = Math.max(0, Math.min(1, opacityOf(c, t) * crossfadeAlpha(track, i, t)));
        out.push({ kind: "media", clip: c, srcTimeMs, alpha, approx: !!c.color });
      } else if (c.title) {
        out.push({ kind: "title", clip: c, alpha: opacityOf(c, t) });
      }
    });
  }
  return out;
}

/**
 * A composição é NÃO-TRIVIAL (a prévia difere de só a trilha base)? É o que
 * decide se vale a pena compor no canvas em vez de mostrar o `<video>` cru:
 * mais de uma camada, título, crossfade, PiP, recorte, opacidade ou cor.
 */
export function needsComposite(layers: Layer[]): boolean {
  if (layers.length > 1) return true;
  return layers.some((l) => {
    if (l.kind === "title") return true;
    const c = l.clip;
    return (
      !!c.transform ||
      !!c.crop ||
      !!c.color ||
      l.alpha < 0.999 ||
      (c.opacityKeyframes?.length ?? 0) > 0
    );
  });
}
