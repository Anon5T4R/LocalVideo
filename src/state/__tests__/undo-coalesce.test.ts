/**
 * O contrato de undo dos SLIDERS do inspetor (v0.4.1).
 *
 * Herança da v0.3: cada tique do `onChange` de um range era um passo de undo —
 * arrastar o volume de 100% pra 50% custava ~10 Ctrl+Z pra desfazer, e ainda
 * empurrava cortes DE VERDADE pra fora do limite do histórico. A mesma classe
 * de bug que o arrasto de PiP na prévia já tinha consertado.
 *
 * A cura é a MESMA sessão `beginEdit`/`endEdit` do aparar/mover/PiP: o
 * `doUpdateClip` empilha no 1º movimento da sessão e daí só troca o presente.
 * Aqui se prende o contrato na STORE (a fiação do pointerdown/up é do
 * componente e se prova na GUI dirigida):
 *
 *  - N mudanças DENTRO de uma sessão = 1 passo de undo;
 *  - edições discretas (número, checkbox — sem sessão) = 1 passo CADA;
 *  - sessões consecutivas não se fundem (dois arrastos = dois passos).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { initHistory, type Timeline } from "../../lib/timeline";
import { useEditor } from "../editor";

/** Uma timeline mínima: um clipe de mídia numa trilha de vídeo. */
function tl(): Timeline {
  return {
    version: 2,
    tracks: [
      {
        id: "vt1",
        kind: "video",
        clips: [{ id: "c1", startMs: 0, durationMs: 4000, path: "C:\\v\\a.mp4", srcIn: 0 }],
      },
    ],
  };
}

function volumeOf(): number | undefined {
  return useEditor.getState().history.present.tracks[0].clips[0].volume;
}

beforeEach(() => {
  useEditor.setState({
    history: initHistory(tl()),
    selectedId: "c1",
    editing: false,
    editPushed: false,
    dirty: false,
  });
});

describe("arrasto de slider coalesce em UM passo de undo", () => {
  it("N mudanças dentro de beginEdit/endEdit = 1 passo", () => {
    const s = useEditor.getState();
    expect(s.canUndo()).toBe(false);

    // O arrasto: pointerdown → begin; o range dispara onChange a cada tique.
    s.beginEdit();
    for (let i = 1; i <= 20; i++) {
      useEditor.getState().doUpdateClip("c1", { volume: 1 - i * 0.025 });
    }
    useEditor.getState().endEdit();

    expect(volumeOf()).toBeCloseTo(0.5, 6);
    // UM Ctrl+Z volta ao estado de antes do arrasto — não 20.
    useEditor.getState().doUndo();
    expect(volumeOf()).toBeUndefined(); // volume nunca tinha sido mexido
    expect(useEditor.getState().canUndo()).toBe(false);
  });

  it("edições discretas (sem sessão) seguem 1 passo cada", () => {
    // Input numérico/checkbox: cada onChange é um gesto completo do usuário.
    useEditor.getState().doUpdateClip("c1", { fadeInMs: 500 });
    useEditor.getState().doUpdateClip("c1", { muted: true });

    const s = useEditor.getState();
    expect(s.history.present.tracks[0].clips[0].fadeInMs).toBe(500);
    expect(s.history.present.tracks[0].clips[0].muted).toBe(true);

    // Dois passos: o 1º undo tira o mute, o 2º tira o fade.
    useEditor.getState().doUndo();
    expect(useEditor.getState().history.present.tracks[0].clips[0].muted).toBeUndefined();
    expect(useEditor.getState().history.present.tracks[0].clips[0].fadeInMs).toBe(500);
    useEditor.getState().doUndo();
    expect(useEditor.getState().history.present.tracks[0].clips[0].fadeInMs).toBeUndefined();
    expect(useEditor.getState().canUndo()).toBe(false);
  });

  it("dois arrastos consecutivos = dois passos (sessões não se fundem)", () => {
    useEditor.getState().beginEdit();
    useEditor.getState().doUpdateClip("c1", { volume: 0.8 });
    useEditor.getState().doUpdateClip("c1", { volume: 0.6 });
    useEditor.getState().endEdit();

    useEditor.getState().beginEdit();
    useEditor.getState().doUpdateClip("c1", { volume: 0.4 });
    useEditor.getState().doUpdateClip("c1", { volume: 0.2 });
    useEditor.getState().endEdit();

    expect(volumeOf()).toBeCloseTo(0.2, 6);
    useEditor.getState().doUndo();
    expect(volumeOf()).toBeCloseTo(0.6, 6); // fim do 1º arrasto
    useEditor.getState().doUndo();
    expect(volumeOf()).toBeUndefined();
  });

  it("sessão vazia (clique sem mexer) não empilha nada", () => {
    useEditor.getState().beginEdit();
    useEditor.getState().endEdit();
    expect(useEditor.getState().canUndo()).toBe(false);
  });

  it("o redo sobrevive: desfazer um arrasto e refazer devolve o valor final", () => {
    useEditor.getState().beginEdit();
    useEditor.getState().doUpdateClip("c1", { volume: 0.7 });
    useEditor.getState().doUpdateClip("c1", { volume: 0.3 });
    useEditor.getState().endEdit();

    useEditor.getState().doUndo();
    expect(volumeOf()).toBeUndefined();
    useEditor.getState().doRedo();
    expect(volumeOf()).toBeCloseTo(0.3, 6);
  });
});
