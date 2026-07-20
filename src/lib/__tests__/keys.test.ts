import { describe, expect, it } from "vitest";

import { shouldIgnoreShortcut } from "../keys";

/**
 * `Element` de mentira com só o que a função lê. Evita jsdom (o resto da suíte
 * roda os testes em Node puro) sem deixar de exercitar a função de produção —
 * a lição do LocalFiles 0.5.1 vale aqui: o teste chama a produção, não uma
 * cópia da lógica dela.
 */
function el(tagName: string, opts: { editable?: boolean; dentroDe?: string } = {}) {
  return {
    tagName,
    isContentEditable: !!opts.editable,
    closest: (sel: string) => (opts.dentroDe && sel.includes(opts.dentroDe) ? {} : null),
  } as unknown as Element;
}

describe("shouldIgnoreShortcut", () => {
  it("campo de texto fica com TODA tecla (o Espaço tem que digitar espaço)", () => {
    expect(shouldIgnoreShortcut(el("INPUT"), " ")).toBe(true);
    expect(shouldIgnoreShortcut(el("TEXTAREA"), " ")).toBe(true);
    expect(shouldIgnoreShortcut(el("DIV", { editable: true }), " ")).toBe(true);
    expect(shouldIgnoreShortcut(el("INPUT"), "s")).toBe(true);
  });

  it("botão focado fica com Espaço e Enter — o clique de quem usa teclado", () => {
    // ESTE é o caso do achado: sem isto o atalho global dava `preventDefault()`
    // e matava a ativação nativa do botão.
    expect(shouldIgnoreShortcut(el("BUTTON", { dentroDe: "button" }), " ")).toBe(true);
    expect(shouldIgnoreShortcut(el("BUTTON", { dentroDe: "button" }), "Enter")).toBe(true);
  });

  it("um <span> DENTRO do botão conta como o botão", () => {
    // O alvo do evento pode ser o rótulo, não o botão — por isso é `closest`.
    expect(shouldIgnoreShortcut(el("SPAN", { dentroDe: "button" }), " ")).toBe(true);
  });

  it("mas o botão NÃO fica com os atalhos de edição", () => {
    // A regressão que este teste impede: bloquear cedo demais e matar J/K/L,
    // S e Del sempre que o foco estivesse num botão da barra.
    for (const k of ["j", "k", "l", "s", "Delete", "ArrowRight", "Home"]) {
      expect(shouldIgnoreShortcut(el("BUTTON", { dentroDe: "button" }), k)).toBe(false);
    }
  });

  it("sem controle acionável no caminho, o atalho global manda", () => {
    expect(shouldIgnoreShortcut(el("DIV"), " ")).toBe(false);
    expect(shouldIgnoreShortcut(el("BODY"), " ")).toBe(false);
    expect(shouldIgnoreShortcut(null, " ")).toBe(false);
  });
});
