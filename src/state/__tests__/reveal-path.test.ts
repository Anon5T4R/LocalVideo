/**
 * O caminho do "mostrar na pasta".
 *
 * O reveal nativo (`revealItemInDir`) abre o explorador com o ARQUIVO já
 * selecionado. Quando ele não vai (SO sem suporte, arquivo movido), a gente cai
 * pra abrir só a PASTA — e é `dirName` que calcula qual pasta. Esse caminho vai
 * CRU pro SO (o plugin não passa por shell, então não há o que "escapar"): o
 * risco não é aspas, é cortar no separador errado e abrir a pasta errada — ou
 * nenhuma. É isso que estes casos prendem.
 */
import { describe, expect, it } from "vitest";

import { dirName } from "../editor";

describe("dirName — a pasta que contém o arquivo exportado", () => {
  it("corta no último separador, nos dois mundos", () => {
    expect(dirName("C:\\Users\\Ana\\Vídeos\\montagem.mp4")).toBe("C:\\Users\\Ana\\Vídeos");
    expect(dirName("/home/ana/videos/montagem.mp4")).toBe("/home/ana/videos");
  });

  it("não come a barra da RAIZ (senão abriria a unidade, não a pasta)", () => {
    // `C:\arq` ⇒ `C:\` (a raiz da unidade), NÃO `C:` (que o Windows lê como
    // "diretório atual da unidade C" — outra pasta).
    expect(dirName("C:\\montagem.mp4")).toBe("C:\\");
    // POSIX: `/arq` ⇒ `/` (a raiz), não string vazia.
    expect(dirName("/montagem.mp4")).toBe("/");
  });

  it("nome solto (sem pasta) cai no diretório atual", () => {
    expect(dirName("montagem.mp4")).toBe(".");
  });

  it("preserva caminhos com espaço/acento/símbolo INTEIROS (vão literais pro SO)", () => {
    // Nada de escapar: o caminho segue byte a byte, só o corte muda.
    const p = "D:\\Meus Vídeos (2026)\\João & cia\\take final.mp4";
    expect(dirName(p)).toBe("D:\\Meus Vídeos (2026)\\João & cia");
  });

  it("aguenta separadores misturados (o pior caso do Windows)", () => {
    // Caminho com `/` e `\` no mesmo lugar: corta no ÚLTIMO dos dois.
    expect(dirName("C:/Users/Ana\\saida.mp4")).toBe("C:/Users/Ana");
  });
});
