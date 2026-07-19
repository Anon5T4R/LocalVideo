import { describe, expect, it } from "vitest";

import {
  audioPeaksArgs,
  expectedSamples,
  peakColumns,
  waveformPath,
  PEAK_RATE,
} from "../peaks";

describe("audioPeaksArgs — os args que produzem o fluxo de amostras", () => {
  it("endereça a faixa pelo ORDINAL (`0:a:N`), que é o espaço do audioStreamIndex", () => {
    const a = audioPeaksArgs("C:/take.mkv", 1);
    // O gotcha que já mordeu a suíte: `a:1` é a SEGUNDA faixa de áudio, não o
    // stream 1 do container (que num arquivo com vídeo é a PRIMEIRA faixa).
    // Trocar os dois espaços desenharia a onda do microfone no clipe do áudio
    // do sistema — errado de um jeito que o olho não pega.
    expect(a).toContain("0:a:1");
    expect(a[a.indexOf("-map") + 1]).toBe("0:a:1");
    expect(audioPeaksArgs("x", 0)[3]).toBe("0:a:0");
  });

  it("descarta o vídeo e sai mono, em s16le no stdout", () => {
    const a = audioPeaksArgs("C:/take.mkv", 0);
    // `-vn`: sem ele o ffmpeg decodifica o stream de vídeo à toa e a extração de
    // um take de 1h passa de segundos a minutos.
    expect(a).toContain("-vn");
    expect(a[a.indexOf("-ac") + 1]).toBe("1");
    expect(a[a.indexOf("-f") + 1]).toBe("s16le");
    // Saída no stdout (`-`): nada de arquivo temporário pra criar e limpar.
    expect(a[a.length - 1]).toBe("-");
  });

  it("é o aresample que segura a memória — a taxa vai no filtro", () => {
    expect(audioPeaksArgs("x", 0)).toContain(`aresample=${PEAK_RATE}`);
    expect(audioPeaksArgs("x", 0, 4000)).toContain("aresample=4000");
    // Ordinal negativo (não deveria acontecer) não vira `0:a:-1`, que o ffmpeg
    // recusaria — cai na primeira faixa.
    expect(audioPeaksArgs("x", -3)).toContain("0:a:0");
  });

  it("caminho com espaço/acento vai INTEIRO num argumento só", () => {
    // Não passa por shell (o Rust usa `Command::args`), então não se cita nada:
    // o teste prende que ninguém resolva "escapar" e quebre o caminho em dois.
    const a = audioPeaksArgs("C:/Meus Vídeos/take 1.mkv", 0);
    expect(a[a.indexOf("-i") + 1]).toBe("C:/Meus Vídeos/take 1.mkv");
  });
});

describe("expectedSamples", () => {
  it("converte a duração do probe em amostras na taxa de pico", () => {
    expect(expectedSamples(1000)).toBe(PEAK_RATE);
    expect(expectedSamples(3_600_000)).toBe(PEAK_RATE * 3600);
  });

  it("nunca devolve zero (viraria divisão por zero no balde do Rust)", () => {
    expect(expectedSamples(0)).toBe(1);
    expect(expectedSamples(-5)).toBe(1);
  });
});

describe("peakColumns — trim, velocidade e zoom em cima dos mesmos picos", () => {
  // Um arquivo de 4 s: silêncio, meio, cheio, silêncio (1 s cada).
  const peaks = [0, 0.5, 1, 0];
  const DUR = 4000;

  it("o clipe INTEIRO devolve o arquivo inteiro", () => {
    expect(peakColumns(peaks, DUR, 0, DUR, 4)).toEqual([0, 0.5, 1, 0]);
  });

  it("aparado, desenha só a janela do clipe (é o trecho que se ouve)", () => {
    // srcIn=2000, span=1000 → só o segundo cheio.
    expect(peakColumns(peaks, DUR, 2000, 1000, 1)).toEqual([1]);
    // srcIn=0, span=2000 → silêncio e meio, nada do cheio.
    expect(peakColumns(peaks, DUR, 0, 2000, 2)).toEqual([0, 0.5]);
  });

  it("cada coluna é o MÁXIMO do trecho, nunca a média", () => {
    // Uma coluna só cobrindo o arquivo todo tem que mostrar o pico (1), não a
    // média (0,375): a média sumiria com a sílaba curta que a pessoa procura.
    expect(peakColumns(peaks, DUR, 0, DUR, 1)).toEqual([1]);
  });

  it("velocidade entra pelo srcSpan (2× consome o dobro de fonte)", () => {
    // Um clipe de 2 s a 2× = 4 s de fonte: a onda espreme o arquivo inteiro.
    expect(peakColumns(peaks, DUR, 0, 4000, 4)).toEqual([0, 0.5, 1, 0]);
    // O mesmo clipe a 1× (2 s de fonte) mostra só a primeira metade.
    expect(peakColumns(peaks, DUR, 0, 2000, 4)).toEqual([0, 0, 0.5, 0.5]);
  });

  it("zoom alto (mais colunas que picos) repete em vez de abrir buraco", () => {
    const cols = peakColumns(peaks, DUR, 0, DUR, 8);
    expect(cols).toHaveLength(8);
    expect(cols).toEqual([0, 0, 0.5, 0.5, 1, 1, 0, 0]);
  });

  it("degenerados devolvem vazio em vez de NaN na tela", () => {
    expect(peakColumns([], DUR, 0, DUR, 10)).toEqual([]);
    expect(peakColumns(peaks, 0, 0, DUR, 10)).toEqual([]);
    expect(peakColumns(peaks, DUR, 0, 0, 10)).toEqual([]);
  });

  it("janela fora do arquivo não sai do vetor", () => {
    // Um clipe cujo srcIn passou do fim do arquivo (projeto editado à mão, ou
    // arquivo trocado por um mais curto): prende na última amostra.
    const cols = peakColumns(peaks, DUR, 99_000, 1000, 3);
    expect(cols).toHaveLength(3);
    expect(cols.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it("o número de colunas é grampeado (largura absurda não trava a régua)", () => {
    expect(peakColumns(peaks, DUR, 0, DUR, 99_999)).toHaveLength(4000);
    expect(peakColumns(peaks, DUR, 0, DUR, 0)).toHaveLength(1);
  });
});

describe("waveformPath", () => {
  it("é um polígono FECHADO e espelhado no eixo central", () => {
    const d = waveformPath([1, 0, 1], 30, 100);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    // Espelhado: pra cada y acima do meio (50) há o correspondente abaixo.
    const ys = [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
    const acima = ys.filter((y) => y < 50).length;
    const abaixo = ys.filter((y) => y > 50).length;
    expect(acima).toBe(abaixo);
  });

  it("silêncio vira uma LINHA no meio, não um buraco na onda", () => {
    // O buraco parece falha de renderização; a linha diz "aqui não tem sinal",
    // que é informação de verdade pra quem grava em duas faixas.
    const d = waveformPath([0, 0], 10, 100);
    const ys = [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
    expect(Math.min(...ys)).toBeCloseTo(49.5, 1);
    expect(Math.max(...ys)).toBeCloseTo(50.5, 1);
  });

  it("o pico cheio respeita a folga (não encosta na borda)", () => {
    const ys = [...waveformPath([1], 10, 100).matchAll(/,(-?[\d.]+)/g)].map((m) =>
      parseFloat(m[1]),
    );
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThan(100);
  });

  it("caixa degenerada devolve caminho vazio (nunca `d=NaN`)", () => {
    expect(waveformPath([], 10, 10)).toBe("");
    expect(waveformPath([1], 0, 10)).toBe("");
    expect(waveformPath([1], 10, 0)).toBe("");
  });
});
