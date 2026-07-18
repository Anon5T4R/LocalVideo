import { describe, expect, it } from "vitest";

import {
  containRect,
  heightFrac,
  maxScaleFor,
  movePip,
  PIP_MIN_SCALE,
  pipBox,
  resizePip,
} from "../pip";
import type { Transform } from "../timeline";

/** Um clipe 16:9 num quadro 16:9 → R = outAspect/aspect = 1: altura = largura. */
const T = (x: number, y: number, scale: number): Transform => ({ x, y, scale });

describe("pip — a caixa a partir do transform", () => {
  it("caixa 16:9 em quadro 16:9: h == w (R=1)", () => {
    const b = pipBox(T(0.6, 0.6, 0.35), 16 / 9, 16 / 9);
    expect(b).toEqual({ x: 0.6, y: 0.6, w: 0.35, h: 0.35 });
  });

  it("altura acompanha o aspecto: fonte 4:3 num quadro 16:9 fica MAIS ALTA", () => {
    // R = (16/9)/(4/3) = 1.333… → h = 0.3 * 1.333 = 0.4
    const h = heightFrac(0.3, 4 / 3, 16 / 9);
    expect(h).toBeCloseTo(0.4, 6);
  });

  it("mirror do compilador: dw=scale*W, dh=dw/aspect, dy=h*H", () => {
    // Prova o vínculo com args.ts numericamente. W=1920,H=1080, aspect=16:9.
    const W = 1920;
    const H = 1080;
    const scale = 0.35;
    const aspect = 16 / 9;
    const b = pipBox(T(0.6, 0.6, scale), aspect, W / H);
    const dw = scale * W;
    const dh = dw / aspect;
    expect(b.w * W).toBeCloseTo(dw, 3);
    expect(b.h * H).toBeCloseTo(dh, 3);
  });
});

describe("pip — mover", () => {
  it("soma o delta e mantém a caixa dentro do quadro", () => {
    const { transform } = movePip(T(0.6, 0.6, 0.35), 16 / 9, 16 / 9, 0.1, 0.1);
    // 0.6 + 0.1 = 0.7, cabe (0.7 + 0.35 > 1 → grampeia em 1-0.35=0.65)
    expect(transform.x).toBeCloseTo(0.65, 6);
    expect(transform.y).toBeCloseTo(0.65, 6);
    expect(transform.scale).toBe(0.35);
  });

  it("não deixa passar da borda esquerda/topo", () => {
    const { transform } = movePip(T(0.1, 0.1, 0.35), 16 / 9, 16 / 9, -0.5, -0.5);
    expect(transform.x).toBe(0);
    expect(transform.y).toBe(0);
  });

  it("encaixa a borda esquerda no 0 quando passa perto (snap)", () => {
    const r = movePip(T(0.1, 0.5, 0.3), 16 / 9, 16 / 9, -0.085, 0, 0.02);
    // 0.1 - 0.085 = 0.015, dentro da tolerância 0.02 de 0 → gruda em 0
    expect(r.transform.x).toBe(0);
    expect(r.snapX).toBe(true);
  });

  it("encaixa a borda direita em 1", () => {
    const w = 0.3;
    // pra a direita bater 1, x precisa chegar perto de 0.7
    const r = movePip(T(0.685, 0.5, w), 16 / 9, 16 / 9, 0, 0, 0.02);
    expect(r.transform.x).toBeCloseTo(1 - w, 6);
    expect(r.snapX).toBe(true);
  });

  it("encaixa o CENTRO horizontal em 0.5", () => {
    const w = 0.3;
    // centro em 0.5 quer x = 0.35; parte de 0.34 (centro 0.49) dentro da tol
    const r = movePip(T(0.34, 0.5, w), 16 / 9, 16 / 9, 0, 0, 0.02);
    expect(r.transform.x).toBeCloseTo(0.5 - w / 2, 6);
    expect(r.snapX).toBe(true);
  });

  it("sem tolerância não encaixa", () => {
    const r = movePip(T(0.015, 0.5, 0.3), 16 / 9, 16 / 9, 0, 0, 0);
    expect(r.transform.x).toBeCloseTo(0.015, 6);
    expect(r.snapX).toBe(false);
  });
});

describe("pip — redimensionar", () => {
  it("canto SE: âncora no topo-esquerdo, largura segue o ponteiro", () => {
    // caixa em (0.2,0.2) w=0.2 (16:9). Arrasta o canto SE pra (0.6, …).
    const tr = resizePip(T(0.2, 0.2, 0.2), 16 / 9, 16 / 9, "se", 0.6, 0.6);
    expect(tr.x).toBeCloseTo(0.2, 6); // âncora fixa
    expect(tr.y).toBeCloseTo(0.2, 6);
    expect(tr.scale).toBeCloseTo(0.4, 6); // 0.6 - 0.2
  });

  it("canto NW: âncora no canto oposto (SE); encolher move x/y", () => {
    // caixa (0.3,0.3) w=0.4,h=0.4 (16:9). SE = (0.7,0.7). Arrasta NW pra (0.5,0.5).
    const tr = resizePip(T(0.3, 0.3, 0.4), 16 / 9, 16 / 9, "nw", 0.5, 0.5);
    // nova largura = 0.7 - 0.5 = 0.2 → h 0.2; x = 0.7-0.2=0.5, y = 0.7-0.2=0.5
    expect(tr.scale).toBeCloseTo(0.2, 6);
    expect(tr.x).toBeCloseTo(0.5, 6);
    expect(tr.y).toBeCloseTo(0.5, 6);
  });

  it("segue o eixo VERTICAL quando ele domina (fonte alta)", () => {
    // fonte 4:3 num quadro 16:9 → R = (16/9)/(4/3) = 1.333. SE de (0.1,0.1) w=0.1.
    // Ponteiro puxa mais na vertical: py=0.7 (dh=0.6 → w=0.6/1.333=0.45) vs
    // px=0.3 (w=0.2). Vence a vertical.
    const asp = 4 / 3;
    const out = 16 / 9;
    const tr = resizePip(T(0.1, 0.1, 0.1), asp, out, "se", 0.3, 0.7);
    expect(tr.scale).toBeCloseTo(0.45, 2);
  });

  it("não encolhe abaixo do mínimo", () => {
    const tr = resizePip(T(0.2, 0.2, 0.2), 16 / 9, 16 / 9, "se", 0.201, 0.201);
    expect(tr.scale).toBe(PIP_MIN_SCALE);
  });

  it("não cresce além do que cabe no quadro (altura)", () => {
    // fonte 9:16 (retrato) num quadro 16:9: R grande, altura estoura antes da largura
    const asp = 9 / 16;
    const out = 16 / 9;
    const maxW = maxScaleFor(asp, out);
    const tr = resizePip(T(0, 0, 0.2), asp, out, "se", 2, 2);
    expect(tr.scale).toBeCloseTo(maxW, 6);
    // a altura resultante não passa de 1
    expect(heightFrac(tr.scale, asp, out)).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("pip — retângulo do conteúdo (letterbox)", () => {
  it("quadro 16:9 num palco 16:9 preenche tudo", () => {
    const r = containRect(1600, 900, 1920, 1080);
    expect(r).toEqual({ left: 0, top: 0, width: 1600, height: 900 });
  });

  it("quadro 16:9 num palco mais alto: barra em cima/baixo", () => {
    const r = containRect(1600, 1000, 1920, 1080);
    expect(r.width).toBe(1600);
    expect(r.height).toBeCloseTo(900, 6);
    expect(r.top).toBeCloseTo(50, 6);
    expect(r.left).toBe(0);
  });

  it("quadro retrato (9:16) num palco largo: barra nas laterais", () => {
    const r = containRect(1600, 900, 1080, 1920);
    expect(r.height).toBe(900);
    expect(r.width).toBeCloseTo(900 * (1080 / 1920), 6);
    expect(r.top).toBe(0);
    expect(r.left).toBeGreaterThan(0);
  });

  it("dimensão zero não estoura (guarda)", () => {
    const r = containRect(0, 0, 1920, 1080);
    expect(r).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});
