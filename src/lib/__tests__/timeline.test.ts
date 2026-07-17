import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetIds,
  append,
  canRedo,
  canUndo,
  clipStarts,
  initHistory,
  move,
  pushHistory,
  redo,
  remove,
  replacePresent,
  split,
  timeToClip,
  totalDuration,
  trim,
  undo,
  type Clip,
  type Track,
} from "../timeline";

const clip = (id: string, srcIn: number, srcOut: number, path = "a.mp4"): Clip => ({
  id,
  path,
  srcIn,
  srcOut,
});

/** Três clipes de 1s, 2s e 3s = 6s de filme. */
const base = (): Track => ({
  clips: [clip("a", 0, 1000), clip("b", 5000, 7000, "b.mp4"), clip("c", 0, 3000, "c.mp4")],
});

beforeEach(() => __resetIds());

describe("leitura da trilha", () => {
  it("soma as janelas, não os arquivos", () => {
    expect(totalDuration(base())).toBe(6000);
    expect(totalDuration({ clips: [] })).toBe(0);
    expect(clipStarts(base())).toEqual([0, 1000, 3000]);
  });

  it("timeToClip traduz tempo de timeline pra tempo-fonte", () => {
    const t = base();
    // 500ms de filme = 500ms dentro do 1º arquivo.
    expect(timeToClip(t, 500)).toMatchObject({ index: 0, srcTime: 500, clipStart: 0 });
    // 1500ms de filme = 500ms DEPOIS do srcIn do 2º clipe (que começa em 5000).
    expect(timeToClip(t, 1500)).toMatchObject({ index: 1, srcTime: 5500, clipStart: 1000 });
  });

  it("na emenda exata quem toca é o clipe da direita", () => {
    expect(timeToClip(base(), 1000)).toMatchObject({ index: 1, srcTime: 5000 });
  });

  it("fim do filme e tempo negativo não são clipe nenhum", () => {
    expect(timeToClip(base(), 6000)).toBeNull();
    expect(timeToClip(base(), 999999)).toBeNull();
    expect(timeToClip(base(), -1)).toBeNull();
  });
});

describe("split", () => {
  it("vira um clipe em dois sem mudar a duração do filme", () => {
    const t = split(base(), 1500);
    expect(t.clips.length).toBe(4);
    expect(totalDuration(t)).toBe(6000);
    // O 2º clipe (5000..7000) foi cortado em 5500.
    expect(t.clips[1]).toMatchObject({ srcIn: 5000, srcOut: 5500 });
    expect(t.clips[2]).toMatchObject({ srcIn: 5500, srcOut: 7000, path: "b.mp4" });
    // A metade nova ganha id próprio (senão a seleção pegaria as duas).
    expect(t.clips[2].id).not.toBe(t.clips[1].id);
  });

  it("cortar no 0 é não-evento (devolve a MESMA trilha)", () => {
    const t = base();
    expect(split(t, 0)).toBe(t);
  });

  it("cortar no fim exato é não-evento", () => {
    const t = base();
    expect(split(t, 6000)).toBe(t);
    expect(split(t, 99999)).toBe(t);
  });

  it("cortar em cima de uma emenda é não-evento (já tem corte ali)", () => {
    const t = base();
    expect(split(t, 1000)).toBe(t);
    expect(split(t, 3000)).toBe(t);
  });

  it("cortar duas vezes no mesmo clipe dá três pedaços contíguos", () => {
    const t = split(split({ clips: [clip("a", 0, 3000)] }, 1000), 2000);
    expect(t.clips.map((c) => [c.srcIn, c.srcOut])).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
    ]);
    expect(totalDuration(t)).toBe(3000);
  });
});

describe("trim", () => {
  it("apara pra uma janela nova", () => {
    const t = trim(base(), "b", 5500, 6000);
    expect(t.clips[1]).toMatchObject({ srcIn: 5500, srcOut: 6000 });
    expect(totalDuration(t)).toBe(1000 + 500 + 3000);
  });

  it("in/out invertidos são trocados, não recusados", () => {
    // Arrastar a alça esquerda passando da direita é gesto comum.
    const t = trim(base(), "b", 6500, 5200);
    expect(t.clips[1]).toMatchObject({ srcIn: 5200, srcOut: 6500 });
  });

  it("não deixa a janela sair do arquivo", () => {
    const t = trim(base(), "b", -500, 99999, 8000);
    expect(t.clips[1]).toMatchObject({ srcIn: 0, srcOut: 8000 });
  });

  it("aparar até zero é ignorado (quem quer sumir usa remove)", () => {
    const t = base();
    expect(trim(t, "b", 5000, 5000)).toBe(t);
    expect(trim(t, "b", 6000, 5000, 5000)).toBe(t); // grampeado até virar vazio
  });

  it("id que não existe é não-evento", () => {
    const t = base();
    expect(trim(t, "zzz", 0, 100)).toBe(t);
  });
});

describe("move", () => {
  it("reordena pro índice da lista já sem o clipe", () => {
    const t = move(base(), "c", 0);
    expect(t.clips.map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(totalDuration(t)).toBe(6000);
  });

  it("índice além do fim grampeia no último (soltar 'lá longe')", () => {
    expect(move(base(), "a", 99).clips.map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(move(base(), "c", -5).clips.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("soltar no mesmo lugar é não-evento", () => {
    const t = base();
    expect(move(t, "a", 0)).toBe(t);
    expect(move(t, "zzz", 1)).toBe(t);
  });
});

describe("remove e append", () => {
  it("remove tira só o clipe pedido", () => {
    const t = remove(base(), "b");
    expect(t.clips.map((c) => c.id)).toEqual(["a", "c"]);
    expect(totalDuration(t)).toBe(4000);
  });

  it("remover o que não existe é não-evento", () => {
    const t = base();
    expect(remove(t, "zzz")).toBe(t);
  });

  it("append põe no fim sem tocar no resto", () => {
    const t = append(base(), clip("d", 0, 500, "d.mp4"));
    expect(t.clips.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    expect(totalDuration(t)).toBe(6500);
  });
});

describe("undo/redo", () => {
  it("desfaz e refaz o corte", () => {
    let h = initHistory(base());
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);

    h = pushHistory(h, split(h.present, 1500));
    expect(h.present.clips.length).toBe(4);
    expect(canUndo(h)).toBe(true);

    h = undo(h);
    expect(h.present.clips.length).toBe(3);
    expect(canRedo(h)).toBe(true);

    h = redo(h);
    expect(h.present.clips.length).toBe(4);
    expect(canRedo(h)).toBe(false);
  });

  it("um arrasto de alça inteiro é UM passo de undo", () => {
    // O retrato do bug achado dirigindo a janela: `doTrim` empilhava a cada
    // `pointermove`, então um arrasto de 80px voltava ~4px por Ctrl+Z. Aqui se
    // imita o arrasto: empilha no 1º movimento, troca o presente no resto.
    let h = initHistory(base());
    const antes = h.present;

    h = pushHistory(h, trim(h.present, "a", 0, 900, 1000)); // 1º movimento
    for (let out = 880; out >= 700; out -= 20) {
      h = replacePresent(h, trim(h.present, "a", 0, out, 1000)); // o resto do arrasto
    }
    expect(h.present.clips[0].srcOut).toBe(700);
    // Dez movimentos, UM passo: o passado tem só o estado de antes do arrasto.
    expect(h.past.length).toBe(1);

    h = undo(h);
    expect(h.present).toBe(antes);
    expect(canUndo(h)).toBe(false);
  });

  it("replacePresent não queima o futuro nem o passado", () => {
    // Trocar o presente no meio de um arrasto não pode custar o redo de outra
    // coisa — quem queima o futuro é o `pushHistory`, e só ele.
    let h = initHistory(base());
    h = pushHistory(h, split(h.present, 1500));
    h = undo(h);
    expect(canRedo(h)).toBe(true);

    const trocado = replacePresent(h, trim(h.present, "a", 0, 800, 1000));
    expect(trocado.future).toBe(h.future);
    expect(trocado.past).toBe(h.past);
    // Não-evento não mexe no histórico (mesmo contrato do pushHistory).
    expect(replacePresent(h, h.present)).toBe(h);
  });

  it("desfaz uma pilha inteira, na ordem inversa", () => {
    let h = initHistory(base());
    h = pushHistory(h, split(h.present, 1500));
    h = pushHistory(h, remove(h.present, "a"));
    h = pushHistory(h, move(h.present, "c", 0));
    expect(h.present.clips.length).toBe(3);

    h = undo(undo(undo(h)));
    expect(h.present.clips.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(canUndo(h)).toBe(false);
    // Desfazer no fundo da pilha não explode nem some com o presente.
    expect(undo(h)).toBe(h);
    expect(redo(redo(redo(redo(h)))).present.clips.length).toBe(3);
  });

  it("editar depois de desfazer queima o futuro", () => {
    let h = initHistory(base());
    h = pushHistory(h, remove(h.present, "a"));
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = pushHistory(h, remove(h.present, "c"));
    expect(canRedo(h)).toBe(false);
    expect(h.present.clips.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("não-evento não entra no histórico (Ctrl+Z não gasta passo à toa)", () => {
    let h = initHistory(base());
    const same = split(h.present, 0); // cortar no 0 = nada
    h = pushHistory(h, same);
    expect(canUndo(h)).toBe(false);
  });

  it("o estado antigo não é mutado (undo devolve o retrato de verdade)", () => {
    const original = base();
    let h = initHistory(original);
    h = pushHistory(h, trim(h.present, "b", 5500, 6000));
    h = undo(h);
    expect(h.present).toBe(original);
    expect(original.clips[1]).toMatchObject({ srcIn: 5000, srcOut: 7000 });
  });
});
