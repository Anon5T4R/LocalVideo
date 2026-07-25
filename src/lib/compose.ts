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
  isImageClip,
  transitionDir,
  type Clip,
  type ColorAdjust,
  type Keyframe,
  type Timeline,
  type Track,
  type TransitionDir,
  type TransitionKind,
} from "./timeline";

/** A transição em CURSO numa camada (v0.4.1): wipe/slide no meio da entrada.
 *  `progress` é 0..1 dentro da sobreposição — a MESMA fração que o compilador
 *  manda pro ffmpeg (fronteira da cortina em `W·p`; x do slide em `−W·(1−p)`),
 *  pra prévia e export mostrarem a mesma fronteira. Dissolve não vem por aqui:
 *  ele continua sendo só o `alpha`. */
export interface TransitionState {
  kind: TransitionKind;
  dir: TransitionDir;
  progress: number;
}

/**
 * O retângulo JÁ REVELADO por um wipe, em pixels do quadro de saída.
 *
 * É o gêmeo em canvas do `wipeVisibleExpr` do compilador (`lib/args.ts`) — as
 * duas descrevem a MESMA fronteira, uma como condição por pixel pro ffmpeg e
 * outra como retângulo de recorte pro `ctx.clip()`. Estar em módulo puro e
 * testado é o que impede a prévia de divergir do arquivo exportado: quando as
 * duas discordam, o usuário só descobre depois de esperar o render.
 */
export function wipeRect(
  dir: TransitionDir,
  p: number,
  W: number,
  H: number,
): { x: number; y: number; w: number; h: number } {
  const f = Math.max(0, Math.min(1, p));
  switch (dir) {
    case "lr":
      return { x: 0, y: 0, w: W * f, h: H };
    case "rl":
      return { x: W * (1 - f), y: 0, w: W * f, h: H };
    case "tb":
      return { x: 0, y: 0, w: W, h: H * f };
    case "bt":
      return { x: 0, y: H * (1 - f), w: W, h: H * f };
  }
}

/**
 * O deslocamento do quadro que entra num SLIDE, em pixels. Gêmeo do
 * `slideOverlayXY` do compilador, pelo mesmo motivo do `wipeRect`.
 *
 * Em `p = 0` o quadro está inteiro fora da tela pelo lado da direção; em `p = 1`
 * está em (0,0). Sem grampo aqui porque quem chama já limita `p` a 0..1 — a
 * camada nem existe fora da sobreposição.
 */
export function slideOffset(
  dir: TransitionDir,
  p: number,
  W: number,
  H: number,
): { dx: number; dy: number } {
  const f = Math.max(0, Math.min(1, p));
  // `(f-1)*W` e não `-(1-f)*W`: a segunda forma devolve **−0** quando `f = 1`
  // (fim da transição). O canvas desenha igual, mas `-0 !== 0` pro `Object.is`
  // — ou seja, o teste que prova "termina cravado em (0,0)" falharia por um
  // sinal invisível. Mesmo resultado, sem a armadilha.
  switch (dir) {
    case "lr":
      return { dx: (f - 1) * W, dy: 0 };
    case "rl":
      return { dx: (1 - f) * W, dy: 0 };
    case "tb":
      return { dx: 0, dy: (f - 1) * H };
    case "bt":
      return { dx: 0, dy: (1 - f) * H };
  }
}

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
  /** Wipe/slide em curso (o desenho recorta/desloca). Ausente = sem transição
   *  espacial neste instante (dissolve já está dentro do `alpha`). */
  transition?: TransitionState;
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
        // A fração da transição de entrada (1 = fora/terminou). O TIPO mora no
        // clipe DE TRÁS. Wipe/slide são ESPACIAIS: a camada entra opaca e o
        // desenho recorta/desloca — então o progresso vai em `transition`, não
        // no alpha. PiP cai no dissolve, espelhando o compilador.
        const xf = crossfadeAlpha(track, i, t);
        const prev = i > 0 ? track.clips[i - 1] : undefined;
        const kind: TransitionKind =
          prev?.path !== undefined && !c.transform ? (prev.transitionKind ?? "dissolve") : "dissolve";
        const spatial = kind !== "dissolve" && xf < 1;
        const alpha = Math.max(0, Math.min(1, opacityOf(c, t) * (spatial ? 1 : xf)));
        out.push({
          kind: "media",
          clip: c,
          srcTimeMs,
          alpha,
          approx: !!c.color,
          ...(spatial
            ? { transition: { kind, dir: prev ? transitionDir(prev) : "lr", progress: xf } }
            : {}),
        });
      } else if (c.title) {
        out.push({ kind: "title", clip: c, alpha: opacityOf(c, t) });
      }
    });
  }
  return out;
}

/**
 * Dá pra DECODIFICAR tudo o que estas camadas pedem?
 *
 * Mora aqui, puro e testado, porque a versão que morava solta no `Preview.tsx`
 * escondeu o bug da imagem preta por uma versão inteira. Ela era
 * `hasWebCodecs() && layers.every(l => canDecodeExactly(l.path))` — e
 * `canDecodeExactly` só diz sim pros containers que o mp4box abre. Um `.png`
 * reprovava; reprovando, a composição não rodava; e como imagem também não vai
 * pro `<video>` (que não decodifica png), **não sobrava caminho nenhum e a
 * prévia ficava preta**. Uma timeline feita de uma foto — exatamente "montar um
 * vídeo a partir de uma imagem" — não mostrava nada.
 *
 * A regra certa: **imagem não passa pelo portão do WebCodecs**, porque ela é
 * decodificada por `createImageBitmap`. `canDecode` entra por parâmetro pra este
 * módulo seguir sem saber o que é mp4box.
 */
export function canDecodeLayers(
  layers: Layer[],
  missing: string[],
  canDecode: (path: string) => boolean,
): boolean {
  return layers.every((l) => {
    if (l.kind !== "media") return true;
    const path = l.clip.path!;
    if (missing.includes(path)) return false;
    return isImageClip(l.clip) || canDecode(path);
  });
}

/**
 * Alguma camada exige decodificar VÍDEO de verdade? (imagem parada e título não)
 *
 * É o que autoriza compor DURANTE o play. A regra geral — tocando, quem manda é
 * o `<video>` — existe por custo: compor N filmes a 30 fps é decodificar vários
 * arquivos ao mesmo tempo. Uma foto e um texto não têm esse custo. Sem esta
 * exceção, apertar play numa timeline de foto + música devolvia PRETO: a imagem
 * não vai pro `<video>` e o canvas se escondia por ser play.
 */
export function needsVideoDecode(layers: Layer[]): boolean {
  return layers.some((l) => l.kind === "media" && !isImageClip(l.clip));
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
      // Imagem: o `<video>` não decodifica png (ver `timeToClip`), então uma
      // imagem, mesmo sozinha, tem que ir pela composição no canvas.
      !!c.image ||
      // Rotação/espelho (v0.14): o `<video>` cru mostra o quadro original; a
      // orientação só existe no canvas composto.
      !!c.rotate ||
      !!c.flipH ||
      !!c.transform ||
      !!c.crop ||
      !!c.color ||
      l.alpha < 0.999 ||
      (c.opacityKeyframes?.length ?? 0) > 0
    );
  });
}
