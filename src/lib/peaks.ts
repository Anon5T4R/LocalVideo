/**
 * Forma de onda dos clipes de áudio: os ARGUMENTOS da extração e a matemática de
 * desenho. TS puro (testado) — o Rust só roda o binário e conta os picos.
 *
 * ─── O buraco que isto fecha ─────────────────────────────────────────────────
 *
 * Um clipe de áudio na régua era uma CAIXA VAZIA com um rótulo. Quem grava no
 * LocalRecord (duas faixas: microfone e áudio do sistema) e vem editar aqui
 * editava o som **às cegas**: não dá pra ver onde a fala começa, onde há silêncio
 * pra cortar, nem qual das duas faixas tem sinal. É o que mais faltava.
 *
 * ─── Por que picos, e não o PCM ──────────────────────────────────────────────
 *
 * O caminho ingênuo (decodificar o áudio e olhar as amostras no front) não cabe
 * na memória: **1 h de PCM 48 kHz estéreo 16 bits ≈ 660 MB**. Então a redução
 * acontece o mais cedo possível — no próprio ffmpeg (`aresample` pra mono em
 * {@link PEAK_RATE} Hz) — e o que atravessa o pipe é um fluxo pequeno que o Rust
 * consome em pedaços, guardando só o MÁXIMO de cada balde. O que chega ao front
 * são {@link PEAKS_PER_FILE} números por faixa: alguns KB, não centenas de MB.
 *
 * Sobre o `asetnsamples` (que a spec desta fatia sugeria): ele só fixa o TAMANHO
 * DO FRAME de áudio dentro do grafo — com saída `s16le` crua no stdout o
 * enquadramento se perde de qualquer jeito, e quem define a memória é o tamanho
 * do buffer de leitura do Rust (constante). Ficou de fora por não fazer nada
 * aqui; quem segura a memória é o `aresample` + a leitura em pedaços.
 */

/**
 * Taxa (Hz) do fluxo mono que sai do ffmpeg pra virar pico.
 *
 * 8 kHz não é escolha de qualidade — é de RESOLUÇÃO DE DESENHO. Com 2000 baldes,
 * um arquivo de 1 h dá 1,8 s por balde (14 400 amostras); um de 10 s dá 5 ms (40
 * amostras). Nos dois casos sobra amostra de sobra pro pico do balde ser o pico
 * real do trecho. Subir a taxa só engordaria o pipe sem mudar um pixel.
 */
export const PEAK_RATE = 8000;

/**
 * Quantos picos por faixa. 2000 é o número que cobre o pior caso de tela: uma
 * timeline aberta a 400 px/s desenha ~2 px por coluna, e nem o monitor mais
 * largo pede mais colunas que isto pra um clipe só. Em JSON são ~8 KB por faixa.
 */
export const PEAKS_PER_FILE = 2000;

/**
 * Os args do ffmpeg que produzem o fluxo de amostras de UMA faixa de áudio.
 *
 * `ordinal` é o ORDINAL ENTRE OS ÁUDIOS (o `N` de `0:a:N`) — o mesmo espaço de
 * índice do `Clip.audioStreamIndex` e o mesmo que o compilador usa em
 * `lib/args.ts`. **Não** é o `AudioTrackInfo.index` (índice do stream no
 * container): num take do LocalRecord as duas faixas são os streams 1 e 2, mas
 * os ordinais 0 e 1. Confundir os dois já custou um bug (ver `audioTrackAt` em
 * `lib/probe.ts`), e aqui o preço seria desenhar a onda do microfone no clipe do
 * áudio do sistema — errado de um jeito que o olho não pega.
 *
 * `-vn` não é decoração: sem ele o ffmpeg ainda abre e decodifica o stream de
 * vídeo do container à toa, e a extração de um take de 1 h passa de segundos a
 * minutos.
 */
export function audioPeaksArgs(path: string, ordinal: number, rate = PEAK_RATE): string[] {
  const n = Math.max(0, Math.round(ordinal));
  return [
    "-i",
    path,
    "-map",
    `0:a:${n}`,
    "-vn",
    "-ac",
    "1",
    "-filter:a",
    `aresample=${Math.max(1000, Math.round(rate))}`,
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "-",
  ];
}

/**
 * Quantas amostras o Rust deve ESPERAR desta faixa — é o que transforma
 * "amostra nº k" em "balde nº j" sem precisar ler o arquivo duas vezes.
 *
 * A duração vem do probe (o container), então o número é aproximado: se o fluxo
 * vier mais curto, os últimos baldes ficam em zero (silêncio no fim — honesto);
 * se vier mais longo, o excedente entope o último balde. Nos dois casos a onda
 * continua alinhada com o tempo, que é o que importa pra achar a fala.
 */
export function expectedSamples(durationMs: number, rate = PEAK_RATE): number {
  return Math.max(1, Math.round((Math.max(0, durationMs) / 1000) * rate));
}

/**
 * Os picos que este CLIPE desenha, em `columns` colunas.
 *
 * Três coisas ao mesmo tempo, e é por isso que é uma função pura com teste:
 *
 * 1. **Trim** — o clipe mostra a janela `srcIn .. srcIn+srcSpan` do arquivo, não
 *    o arquivo inteiro. Aparar tem que andar com a onda; desenhar o arquivo todo
 *    faria a onda mentir sobre o que se ouve ali.
 * 2. **Velocidade** — quem chama passa `srcSpanMs` = `duração × velocidade` (a
 *    mesma invariante do compilador): um clipe a 2× consome o dobro de fonte, e
 *    a onda tem que espremer junto.
 * 3. **Zoom** — o número de colunas vem da LARGURA em pixels, então ampliar
 *    revela detalhe em vez de esticar uma imagem borrada.
 *
 * Cada coluna é o MÁXIMO do trecho que ela cobre (nunca a média): a média some
 * com um pico de fala curto no meio de um trecho quieto, que é exatamente o que
 * a pessoa está procurando quando abre a onda.
 */
export function peakColumns(
  peaks: number[],
  fileDurationMs: number,
  srcInMs: number,
  srcSpanMs: number,
  columns: number,
): number[] {
  const n = Math.max(1, Math.min(Math.round(columns), 4000));
  if (peaks.length === 0 || fileDurationMs <= 0 || srcSpanMs <= 0) return [];
  const out: number[] = [];
  const perMs = peaks.length / fileDurationMs;
  for (let k = 0; k < n; k++) {
    const a = srcInMs + (srcSpanMs * k) / n;
    const b = srcInMs + (srcSpanMs * (k + 1)) / n;
    let i0 = Math.floor(a * perMs);
    let i1 = Math.ceil(b * perMs);
    // Uma coluna mais estreita que um pico (zoom alto) ainda tem que mostrar
    // ALGUMA coisa: cai no pico que estiver debaixo dela.
    if (i1 <= i0) i1 = i0 + 1;
    i0 = Math.max(0, Math.min(i0, peaks.length - 1));
    i1 = Math.max(i0 + 1, Math.min(i1, peaks.length));
    let m = 0;
    for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
    out.push(m);
  }
  return out;
}

/**
 * O caminho SVG da onda: um polígono espelhado no eixo central, como todo NLE
 * desenha. Um `<path>` só — e não uma barra por coluna — porque um clipe largo
 * pede centenas de colunas e centenas de `<div>` custariam caro em cada quadro
 * de um arrasto.
 *
 * O `viewBox` é o próprio `w × h` e o `preserveAspectRatio` fica desligado no
 * componente: assim a onda acompanha a caixa do clipe sem redesenhar nada quando
 * só a altura muda.
 */
export function waveformPath(cols: number[], w: number, h: number): string {
  if (cols.length === 0 || w <= 0 || h <= 0) return "";
  const mid = h / 2;
  // 0.92 deixa uma folga de respiro: uma onda batendo na borda parece cortada
  // (e some debaixo da borda de seleção do clipe).
  const amp = mid * 0.92;
  const x = (k: number) => ((k * w) / cols.length).toFixed(1);
  const top: string[] = [];
  const bottom: string[] = [];
  for (let k = 0; k < cols.length; k++) {
    const v = Math.max(0, Math.min(1, cols[k]));
    // Mínimo de meio pixel: trecho em silêncio vira uma LINHA no meio, não um
    // buraco na onda — a linha diz "aqui é silêncio", o buraco parece falha.
    const dy = Math.max(0.5, v * amp);
    top.push(`${x(k)},${(mid - dy).toFixed(1)}`);
    bottom.push(`${x(k)},${(mid + dy).toFixed(1)}`);
  }
  bottom.reverse();
  return `M${top.join("L")}L${bottom.join("L")}Z`;
}
