import { describe, expect, it } from "vitest";

import { snapMove, snapValue } from "../snap";

describe("snapValue", () => {
  it("gruda na marca mais próxima dentro da tolerância", () => {
    const r = snapValue(1008, [0, 1000, 3000], 20);
    expect(r).toEqual({ value: 1000, target: 1000 });
  });

  it("não gruda fora da tolerância", () => {
    const r = snapValue(1030, [0, 1000, 3000], 20);
    expect(r).toEqual({ value: 1030, target: null });
  });

  it("entre duas marcas, pega a mais próxima", () => {
    expect(snapValue(1490, [1000, 1500], 60).value).toBe(1500);
    expect(snapValue(1040, [1000, 1500], 60).value).toBe(1000);
  });

  it("tolerância zero desliga", () => {
    expect(snapValue(1000, [1000], 0)).toEqual({ value: 1000, target: null });
  });
});

describe("snapMove — encaixa a borda mais perto", () => {
  it("gruda o START numa marca", () => {
    // clipe dur 500, arrastado pra start 995; marca em 1000 → start 1000
    const r = snapMove(995, 500, [1000, 3000], 20);
    expect(r).toEqual({ startMs: 1000, guide: 1000 });
  });

  it("gruda o FIM numa marca (start recua pra encaixar a direita)", () => {
    // dur 500, start 2510 → fim 3010; marca em 3000 → fim 3000 → start 2500
    const r = snapMove(2510, 500, [1000, 3000], 20);
    expect(r).toEqual({ startMs: 2500, guide: 3000 });
  });

  it("escolhe a emenda de MENOR folga quando as duas estão no alcance", () => {
    // dur 1000, start 1005: start perto de 1000 (folga 5), fim 2005 perto de 2000 (folga 5).
    // empate → prioriza o start (dStart <= dEnd).
    const r = snapMove(1005, 1000, [1000, 2000], 20);
    expect(r.startMs).toBe(1000);
    expect(r.guide).toBe(1000);
  });

  it("sem marca no alcance devolve o start original", () => {
    const r = snapMove(1234, 500, [0, 5000], 10);
    expect(r).toEqual({ startMs: 1234, guide: null });
  });
});
