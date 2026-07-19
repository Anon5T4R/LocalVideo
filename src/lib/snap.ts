/**
 * Encaixe (snap) da régua — TS puro. É o que faz a edição parecer PRECISA em vez
 * de escorregadia: ao arrastar ou aparar, a borda "quase encostou" numa marca
 * (borda de outro clipe, playhead, o zero) vira "encostou". A tolerância é em
 * MILISSEGUNDOS (a UI a deriva de pixels pelo zoom), então o encaixe fica do
 * mesmo "tamanho de dedo" em qualquer nível de zoom.
 *
 * Mora aqui, puro e testado, porque é conta de posição — e conta de posição sem
 * teste é bug de posição esperando o release.
 */

/**
 * O `scrollLeft` que mantém PARADO o ponto sob o cursor ao mudar o zoom — a
 * conta do Ctrl+roda.
 *
 * Sem ela, ampliar leva o instante que se estava olhando pra fora da tela e o
 * gesto vira "ampliar e depois caçar de novo o lugar". Com ela, o zoom acontece
 * DEBAIXO do cursor, que é o que o dedo espera de qualquer mapa.
 *
 * `anchorPx` é a distância do cursor até o começo do CONTEÚDO (não da viewport):
 * `clientX − rect.left do tl-inner`. Como a posição em tela do ponto é
 * `viewportLeft − scrollLeft + anchorPx`, mantê-la fixa é resolver
 * `−sl₂ + anchorPx·(z₂/z₁) = −sl₁ + anchorPx`. Daí a fórmula abaixo.
 *
 * O piso em 0 é do DOM (não existe scroll negativo); o teto o navegador aplica
 * sozinho ao atribuir, e não dá pra calcular aqui sem saber a largura da
 * viewport — deixar pra ele é mais confiável que adivinhar.
 */
export function anchoredScrollLeft(
  scrollLeft: number,
  anchorPx: number,
  fromPxPerSec: number,
  toPxPerSec: number,
): number {
  if (fromPxPerSec <= 0) return scrollLeft;
  const k = toPxPerSec / fromPxPerSec;
  return Math.max(0, scrollLeft + anchorPx * k - anchorPx);
}

/** Encaixa `value` na marca mais PRÓXIMA dentro de `tol`. Sem marca no alcance,
 *  devolve o valor original e `target: null`. Empate → a marca mais próxima
 *  (a última varrida, por estabilidade). */
export function snapValue(
  value: number,
  targets: number[],
  tol: number,
): { value: number; target: number | null } {
  if (tol <= 0) return { value, target: null };
  let best: number | null = null;
  let bestDist = tol;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d <= bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best === null ? { value, target: null } : { value: best, target: best };
}

/**
 * Encaixe ao MOVER um clipe: tenta grudar tanto a borda ESQUERDA (start) quanto a
 * DIREITA (start+dur) nas marcas, e fica com o encaixe de menor folga. Assim o
 * clipe cola tanto "começo no começo" quanto "fim no começo do próximo" — as
 * duas emendas que o olho procura. Devolve o novo start e a marca que pegou (pra
 * a UI desenhar a guia).
 */
export function snapMove(
  startMs: number,
  durationMs: number,
  targets: number[],
  tol: number,
): { startMs: number; guide: number | null } {
  const byStart = snapValue(startMs, targets, tol);
  const byEnd = snapValue(startMs + durationMs, targets, tol);
  const dStart = byStart.target === null ? Infinity : Math.abs(startMs - byStart.value);
  const dEnd = byEnd.target === null ? Infinity : Math.abs(startMs + durationMs - byEnd.value);
  if (dStart === Infinity && dEnd === Infinity) return { startMs, guide: null };
  if (dStart <= dEnd) return { startMs: byStart.value, guide: byStart.target };
  return { startMs: byEnd.value - durationMs, guide: byEnd.target };
}
