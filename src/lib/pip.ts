/**
 * A matemática do PiP por ARRASTO DIRETO na prévia — TS puro, sem React nem
 * canvas. Mora aqui pelo mesmo motivo do `timeline.ts`: é onde bug de posição se
 * esconde, então tem que dar pra testar cada conta sem abrir janela.
 *
 * ─── O contrato com o compilador (a regra de ouro) ───────────────────────────
 *
 * O `transform` de um clipe é `{x, y, scale}` em FRAÇÕES do quadro de SAÍDA:
 *   - `x`, `y`  = canto superior-esquerdo do PiP (fração da largura/altura de saída).
 *   - `scale`   = LARGURA do PiP como fração da largura de saída.
 * O compilador (`args.ts`) traduz isso em `scale=${scale*W}:-2` (largura fixa,
 * altura pelo aspecto) e `overlay=x=${x*W}:y=${y*H}`. A prévia (`drawMedia`) faz
 * o MESMO: `dw = scale*W`, `dh = dw/aspect`, `dx = x*W`, `dy = y*H`.
 *
 * Logo a ALTURA do PiP não é livre: `dh = dw/aspect`. Em fração da altura de
 * saída isso vira `dh/H = scale * (W/H) / aspect = scale * outAspect / aspect`.
 * Toda a conta abaixo respeita esse vínculo — arrastar um canto muda a LARGURA
 * (o `scale`), e a altura acompanha o aspecto, igualzinho ao export. Assim o que
 * a alça faz na tela é exatamente o que sai no arquivo.
 */

import type { Transform } from "./timeline";

/** Faixa do `scale` (largura fração). Abaixo de 10% o PiP some; 100% cobre a
 *  largura toda (aí já não é bem "picture-in-picture", mas é limite legítimo). */
export const PIP_MIN_SCALE = 0.1;
export const PIP_MAX_SCALE = 1;

/** Os quatro cantos que a alça de redimensionar agarra. */
export type Corner = "nw" | "ne" | "sw" | "se";

/** A caixa do PiP em FRAÇÕES do quadro de saída: `x`/`w` em fração da LARGURA,
 *  `y`/`h` em fração da ALTURA. É o que a UI posiciona sobre o retângulo do
 *  conteúdo na prévia. */
export interface PipBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Grampeia em [lo, hi] (com guarda de NaN). */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * A caixa do PiP a partir do `transform`. `clipAspect` é a razão de aspecto do
 * frame-fonte JÁ RECORTADO (sw/sh — a mesma que o `drawMedia` usa); `outAspect`
 * é W/H do quadro de saída. A altura sai do vínculo do overlay (ver o cabeçalho).
 */
export function pipBox(tr: Transform, clipAspect: number, outAspect: number): PipBox {
  const w = tr.scale;
  const h = heightFrac(tr.scale, clipAspect, outAspect);
  return { x: tr.x, y: tr.y, w, h };
}

/** Altura do PiP (fração da altura de saída) pra uma largura `scale` dada. É o
 *  `R = outAspect/aspect` do cabeçalho: `h = scale * R`. */
export function heightFrac(scale: number, clipAspect: number, outAspect: number): number {
  const asp = clipAspect > 0 ? clipAspect : 1;
  return (scale * outAspect) / asp;
}

/** A maior largura (`scale`) que ainda cabe no quadro: limitada por 1 (largura),
 *  por `1/R` (pra a altura não passar de 1) e pelo teto absoluto. */
export function maxScaleFor(clipAspect: number, outAspect: number): number {
  const asp = clipAspect > 0 ? clipAspect : 1;
  const byHeight = asp / outAspect; // scale onde h == 1
  return Math.min(PIP_MAX_SCALE, 1, byHeight);
}

/**
 * MOVER o PiP: soma o deslocamento (em frações) à posição, mantém a caixa
 * INTEIRA dentro do quadro (um NLE de verdade não deixa o PiP fugir da tela ao
 * arrastar), e ENCAIXA (snap) as bordas/centro no quadro quando passam perto —
 * com `snapTol` em fração (0 desliga). Devolve o `transform` novo e quais eixos
 * grudaram (pra a UI desenhar a guia).
 */
export function movePip(
  tr: Transform,
  clipAspect: number,
  outAspect: number,
  dxFrac: number,
  dyFrac: number,
  snapTol = 0,
): { transform: Transform; snapX: boolean; snapY: boolean } {
  const w = tr.scale;
  const h = heightFrac(tr.scale, clipAspect, outAspect);
  // A caixa nunca é maior que o quadro (o resize garante isso), mas guarda:
  const maxX = Math.max(0, 1 - w);
  const maxY = Math.max(0, 1 - h);

  let nx = clamp(tr.x + dxFrac, 0, maxX);
  let ny = clamp(tr.y + dyFrac, 0, maxY);
  let snapX = false;
  let snapY = false;

  if (snapTol > 0) {
    // Alvos horizontais: borda esquerda→0, direita→1, centro→0.5.
    const left = nx;
    const right = nx + w;
    const cx = nx + w / 2;
    if (Math.abs(left - 0) <= snapTol) {
      nx = 0;
      snapX = true;
    } else if (Math.abs(right - 1) <= snapTol) {
      nx = clamp(1 - w, 0, maxX);
      snapX = true;
    } else if (Math.abs(cx - 0.5) <= snapTol) {
      nx = clamp(0.5 - w / 2, 0, maxX);
      snapX = true;
    }
    const top = ny;
    const bottom = ny + h;
    const cy = ny + h / 2;
    if (Math.abs(top - 0) <= snapTol) {
      ny = 0;
      snapY = true;
    } else if (Math.abs(bottom - 1) <= snapTol) {
      ny = clamp(1 - h, 0, maxY);
      snapY = true;
    } else if (Math.abs(cy - 0.5) <= snapTol) {
      ny = clamp(0.5 - h / 2, 0, maxY);
      snapY = true;
    }
  }

  return { transform: { x: nx, y: ny, scale: tr.scale }, snapX, snapY };
}

/**
 * REDIMENSIONAR o PiP por um canto. O canto OPOSTO fica ancorado (fixo); o canto
 * arrastado vai pro ponteiro (`px`/`py` em fração do quadro). A largura nova sai
 * da distância horizontal ao âncora — a altura ACOMPANHA o aspecto (vínculo do
 * overlay), então o PiP nunca distorce. Grampeado pra caber no quadro e não
 * sumir (PIP_MIN_SCALE).
 */
export function resizePip(
  tr: Transform,
  clipAspect: number,
  outAspect: number,
  corner: Corner,
  px: number,
  py: number,
): Transform {
  const w = tr.scale;
  const h = heightFrac(tr.scale, clipAspect, outAspect);
  const right = corner === "se" || corner === "ne"; // canto arrastado está à direita?
  const bottom = corner === "se" || corner === "sw"; // …e embaixo?

  // Âncora = canto oposto (fica fixo).
  const anchorX = right ? tr.x : tr.x + w;
  const anchorY = bottom ? tr.y : tr.y + h;

  // Aspecto travado ⇒ um grau de liberdade. Pra o canto SEGUIR o ponteiro em
  // qualquer direção, mede a distância nos DOIS eixos (a vertical vira largura
  // dividindo por R = h/w) e fica com a MAIOR — assim o canto alcança o ponteiro
  // no eixo dominante em vez de só no horizontal.
  const R = heightFrac(1, clipAspect, outAspect); // h = w * R
  const rawWfromX = right ? px - anchorX : anchorX - px;
  const rawHfromY = bottom ? py - anchorY : anchorY - py;
  const rawWfromY = R > 0 ? rawHfromY / R : 0;
  const rawW = Math.max(rawWfromX, rawWfromY);
  const maxW = maxScaleFor(clipAspect, outAspect);
  const newW = clamp(rawW, PIP_MIN_SCALE, maxW);
  const newH = heightFrac(newW, clipAspect, outAspect);

  // Reposiciona mantendo o âncora; depois garante que a caixa fica no quadro.
  let nx = right ? anchorX : anchorX - newW;
  let ny = bottom ? anchorY : anchorY - newH;
  nx = clamp(nx, 0, Math.max(0, 1 - newW));
  ny = clamp(ny, 0, Math.max(0, 1 - newH));

  return { x: nx, y: ny, scale: newW };
}

/**
 * O retângulo do CONTEÚDO dentro do palco (o `object-fit: contain`): onde o
 * quadro `W×H` realmente aparece num palco `stageW×stageH` (o resto é barra
 * preta). A UI ancora as alças do PiP neste retângulo — sem isso, uma alça no
 * "40%" cairia sobre a barra preta, não sobre a imagem. Puro pra testar o
 * letterbox sem medir DOM.
 */
export function containRect(
  stageW: number,
  stageH: number,
  W: number,
  H: number,
): { left: number; top: number; width: number; height: number } {
  if (stageW <= 0 || stageH <= 0 || W <= 0 || H <= 0) {
    return { left: 0, top: 0, width: Math.max(0, stageW), height: Math.max(0, stageH) };
  }
  const sAspect = stageW / stageH;
  const cAspect = W / H;
  if (cAspect > sAspect) {
    // Conteúdo mais "largo" que o palco: encosta na largura, barra em cima/baixo.
    const width = stageW;
    const height = stageW / cAspect;
    return { left: 0, top: (stageH - height) / 2, width, height };
  }
  // Conteúdo mais "alto": encosta na altura, barra nas laterais.
  const height = stageH;
  const width = stageH * cAspect;
  return { left: (stageW - width) / 2, top: 0, width, height };
}
