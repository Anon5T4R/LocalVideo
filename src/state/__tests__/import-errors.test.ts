/**
 * Regressão do arquivo inválido — o caso que o João relatou mandando o caminho
 * do `corrompido.mp4` três vezes seguidas.
 *
 * O que estava errado NÃO era a frase (essa já era humana e traduzida): era a
 * REPETIÇÃO. Um listener de drag-drop órfão (ver o comentário no `App.tsx`)
 * fazia um drop só importar o mesmo arquivo duas/três vezes, e cada tentativa
 * empilhava um tijolo vermelho idêntico. Aqui prendemos as duas pontas que dão
 * pra prender em teste puro: a mensagem e a contagem.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { setLocale } from "../../lib/i18n";
import { importFailureMessage } from "../editor";
import { useUi } from "../ui";

const DANIFICADO = "não deu pra abrir este arquivo (formato não suportado ou arquivo danificado)";

describe("mensagem do que não entrou", () => {
  beforeEach(() => setLocale("pt"));

  it("nada a dizer quando nada falhou", () => {
    expect(importFailureMessage([])).toBeNull();
  });

  it("um arquivo: NOME + motivo, nunca o caminho absoluto", () => {
    const msg = importFailureMessage([{ name: "corrompido.mp4", why: DANIFICADO }]);
    expect(msg).toBe(`corrompido.mp4 — ${DANIFICADO}`);
    // O que o João viu na tela não pode ser um caminho pelado.
    expect(msg).not.toMatch(/[A-Za-z]:\\/);
    expect(msg).not.toContain("D:\\LocalVideoTeste");
  });

  it("o mesmo arquivo falhando 3x é UMA frase, não três", () => {
    const f = { name: "corrompido.mp4", why: DANIFICADO };
    const msg = importFailureMessage([f, f, f]);
    expect(msg).toBe(`corrompido.mp4 — ${DANIFICADO}`);
    // Sem "3 arquivos": é um arquivo só, pedido três vezes.
    expect(msg).not.toContain("3");
  });

  it("5 arquivos com 2 ruins: os 2 ruins num relato só", () => {
    const msg = importFailureMessage([
      { name: "corrompido.mp4", why: DANIFICADO },
      { name: "truncado.mp4", why: DANIFICADO },
    ])!;
    expect(msg).toContain("corrompido.mp4");
    expect(msg).toContain("truncado.mp4");
    expect(msg).toContain("2 arquivos");
    expect(msg).not.toMatch(/[A-Za-z]:\\/);
  });

  it("lista longa não vira parágrafo", () => {
    const msg = importFailureMessage(
      ["a.mp4", "b.mp4", "c.mp4", "d.mp4", "e.mp4"].map((name) => ({ name, why: DANIFICADO })),
    )!;
    expect(msg).toContain("a.mp4");
    expect(msg).toContain("e mais 2");
    expect(msg).not.toContain("e.mp4");
  });

  it("fala o idioma da UI — jamais pt na tela de quem usa en/es", () => {
    const fs = [
      { name: "a.mp4", why: "damaged" },
      { name: "b.mp4", why: "damaged" },
    ];
    setLocale("en");
    expect(importFailureMessage(fs)).toContain("2 files didn't make it");
    setLocale("es");
    expect(importFailureMessage(fs)).toContain("2 archivos no entraron");
  });
});

describe("toast repetido conta, não empilha", () => {
  beforeEach(() => useUi.setState({ toasts: [] }));

  it("a mesma mensagem 3x = 1 toast com ×3", () => {
    const { pushToast } = useUi.getState();
    pushToast("error", "corrompido.mp4 — quebrado");
    pushToast("error", "corrompido.mp4 — quebrado");
    pushToast("error", "corrompido.mp4 — quebrado");

    const { toasts } = useUi.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].count).toBe(3);
  });

  it("mensagens diferentes continuam sendo toasts diferentes", () => {
    const { pushToast } = useUi.getState();
    pushToast("error", "corrompido.mp4 — quebrado");
    pushToast("error", "truncado.mp4 — quebrado");
    expect(useUi.getState().toasts).toHaveLength(2);
  });

  it("mesmo texto com gravidade diferente não se funde", () => {
    const { pushToast } = useUi.getState();
    pushToast("error", "pronto");
    pushToast("ok", "pronto");
    expect(useUi.getState().toasts).toHaveLength(2);
  });

  it("o id do toast repetido não muda (o React não remonta)", () => {
    const { pushToast } = useUi.getState();
    pushToast("error", "x");
    const id = useUi.getState().toasts[0].id;
    pushToast("error", "x");
    expect(useUi.getState().toasts[0].id).toBe(id);
  });
});
