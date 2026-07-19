/**
 * A ponte entre o painel de mídia e a régua: "se eu soltar AQUI, onde cai?"
 *
 * ─── Por que um registro de módulo e não estado no store ─────────────────────
 *
 * Arrastar do pool pra timeline é um gesto que começa num componente e termina
 * noutro. Os dois candidatos óbvios falham:
 *
 * - **Passar a posição do ponteiro pelo store** faria a `Timeline` inteira
 *   re-renderizar a 60 Hz durante o arrasto — a mesma armadilha que o arrasto de
 *   clipe já evita mantendo o rastro em estado local do componente.
 * - **Cada lado escutar `pointerup` por conta própria** cria uma corrida: quem
 *   limpa o estado do arrasto derruba o `useEffect` do outro no meio do mesmo
 *   despacho de evento, e o drop se perde de vez em quando (o pior tipo de bug:
 *   o que só acontece às vezes).
 *
 * Então o gesto tem UM dono (o `MediaPool`, que o começou) e a `Timeline`
 * publica aqui uma FUNÇÃO PURA de leitura — dado um ponto da tela, devolve a
 * trilha, o instante e a geometria pra desenhar a marca. Quem sabe converter
 * pixel↔ms continua sendo a régua (é lá que moram `pxPerSec`, o `tl-inner` e as
 * lanes); o painel só pergunta.
 *
 * Registro de módulo e não `context` do React porque o consumidor precisa da
 * resposta DENTRO de um `pointermove` — um valor de contexto estaria sempre um
 * render atrasado em relação ao zoom/scroll que acabou de mudar.
 */

/** Onde um arquivo soltado neste ponto da tela cairia. */
export interface LaneDrop {
  /** A trilha sob o ponteiro. */
  trackId: string;
  /** O instante (ms) correspondente, já grampeado em ≥ 0. */
  startMs: number;
  /** Geometria da marca de "cai aqui", em coordenadas de VIEWPORT (`fixed`): o
   *  x do instante e a faixa vertical da lane. */
  left: number;
  top: number;
  height: number;
}

type Resolver = (clientX: number, clientY: number) => LaneDrop | null;

let resolver: Resolver | null = null;

/** A `Timeline` publica (ou retira, com `null`) sua função de leitura. */
export function setLaneResolver(f: Resolver | null) {
  resolver = f;
}

/**
 * Onde este ponto da tela cai. `null` = fora de qualquer lane (soltar ali não
 * faz nada, e é assim que o gesto ganha um "cancelar" natural: solta no vazio).
 */
export function resolveLaneDrop(clientX: number, clientY: number): LaneDrop | null {
  return resolver ? resolver(clientX, clientY) : null;
}
