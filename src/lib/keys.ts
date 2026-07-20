/**
 * Quem fica com a tecla: o atalho global ou o controle focado?
 *
 * Função pura porque a decisão é a parte que erra — e errar aqui é invisível
 * até alguém tentar usar o app só com o teclado. Ver o achado registrado no
 * `App.tsx`: um `<button>` focado recebia o Espaço, o atalho global fazia
 * `preventDefault()` e com isso **cancelava a ativação nativa do botão**. Todo
 * botão do app ficava morto pra teclado, e ainda dava play sem querer.
 */

/** Seletor dos elementos que o navegador ativa sozinho com Espaço/Enter. */
const ACTIVATABLE = "button, select, a[href], summary";

/**
 * O handler global de atalhos deve IGNORAR este evento?
 *
 * Duas famílias, por motivos diferentes:
 * - **Campo de texto**: o Espaço tem que digitar um espaço.
 * - **Controle acionável**: o Espaço/Enter é o clique de quem usa teclado.
 *   As outras teclas (J/K/L, S, Del…) seguem valendo com um botão focado — só
 *   os dois acionadores é que são do controle.
 */
export function shouldIgnoreShortcut(target: Element | null, key: string): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return true;
  if ((key === " " || key === "Enter") && typeof el.closest === "function") {
    return el.closest(ACTIVATABLE) !== null;
  }
  return false;
}
