/**
 * Prévia quadro a quadro de verdade, com WebCodecs (`VideoDecoder`).
 *
 * ─── Por que o `<video>` não basta ──────────────────────────────────────────
 *
 * O `<video>` decide sozinho qual quadro mostrar num `currentTime`. Ele acerta
 * "por perto" e isso é ótimo pra assistir — e insuficiente pra editar: apertar a
 * seta e ver o MESMO quadro (ou pular dois) é o tipo de coisa que faz o usuário
 * desconfiar do corte que ele acabou de fazer. Num NLE, seta = exatamente um
 * quadro. Pra isso é preciso decodificar na mão.
 *
 * ─── Por que tem um demuxer aqui ────────────────────────────────────────────
 *
 * O `VideoDecoder` **não abre arquivo**: ele come `EncodedVideoChunk`, que é
 * quadro comprimido pelado. Quem tira os quadros de dentro do container (o mp4,
 * com suas tabelas de amostra) é o demuxer — daí o mp4box.js. Não é acessório:
 * sem ele, o `VideoDecoder` não tem o que decodificar.
 *
 * E é isso que limita o alcance: o mp4box só lê **MP4/MOV/M4V**. Em MKV, WebM ou
 * AVI esta via não abre, e o app **diz isso** em vez de fingir precisão que não
 * tem. Ver `canDecodeExactly()`.
 *
 * ─── O GOTCHA que apaga tudo ────────────────────────────────────────────────
 *
 * `VideoDecoder` é **SecureContext-gated**: ele simplesmente **não existe** num
 * contexto não-trustworthy. Produção (`tauri.localhost`) e dev (`localhost`) são
 * OK; uma página de erro é `origin: null` e ali ele SOME. Testar fora do app
 * servido dá **falso negativo** — e a armadilha é que `VideoFrame` e
 * `EncodedVideoChunk` **não** são gated: eles continuam lá, dando a impressão de
 * "meio suportado". Só a presença de `VideoDecoder` conta como sinal.
 */

import MP4Box, { type MP4ArrayBuffer, type MP4File, type MP4Sample, type MP4Track } from "mp4box";

/** Metadado de um quadro comprimido, já em microssegundos (a unidade do WebCodecs). */
export interface SampleMeta {
  /** Instante de APRESENTAÇÃO (cts), em µs. */
  tsUs: number;
  durUs: number;
  /** É quadro-chave? (só a partir deles dá pra começar a decodificar) */
  isSync: boolean;
}

/** O trecho a decodificar pra mostrar UM quadro. Índices na ordem de DECODIFICAÇÃO. */
export interface DecodeRange {
  start: number;
  end: number;
}

/**
 * Qual pedaço decodificar pra ter o quadro do instante `targetUs`.
 *
 * Pura, e testada — é aqui que mora o erro de ±1 que faz a seta pular quadro.
 *
 * Duas armadilhas moram nesta função:
 *
 * 1. **Ordem de decodificação ≠ ordem de apresentação.** Com B-frames o quadro
 *    do segundo 5 pode estar guardado DEPOIS do quadro do segundo 6. Por isso a
 *    busca do alvo é por `cts` (apresentação) mas o RANGE é por índice de
 *    decodificação.
 * 2. Por causa disso, decodificar só até o alvo não basta: decodifica-se o **GOP
 *    inteiro** (do quadro-chave até o quadro antes do próximo). Parar no alvo
 *    deixaria de fora um quadro que o alvo referencia, e o resultado é macaco na
 *    tela ou quadro nenhum.
 */
export function pickDecodeRange(samples: SampleMeta[], targetUs: number): DecodeRange | null {
  if (samples.length === 0) return null;

  // O quadro que está NO AR no instante pedido: o último cuja apresentação já
  // começou. (Antes do primeiro, é o primeiro — não é erro, é o começo do vídeo.)
  let target = 0;
  let bestTs = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const ts = samples[i].tsUs;
    if (ts <= targetUs && ts > bestTs) {
      bestTs = ts;
      target = i;
    }
  }

  // Volta até o quadro-chave: é o único ponto de partida possível: um quadro
  // comum é só a DIFERENÇA pro anterior, não uma imagem.
  let start = 0;
  for (let i = target; i >= 0; i--) {
    if (samples[i].isSync) {
      start = i;
      break;
    }
  }

  // Vai até o fim do GOP (o quadro antes do próximo quadro-chave).
  let end = samples.length - 1;
  for (let i = start + 1; i < samples.length; i++) {
    if (samples[i].isSync) {
      end = i - 1;
      break;
    }
  }
  // Alvo depois do fim do GOP não deveria acontecer, mas se o arquivo mentir na
  // tabela é melhor esticar do que devolver um range que não contém o alvo.
  if (end < target) end = target;

  return { start, end };
}

/**
 * Entre os quadros decodificados, qual mostrar: o último que já começou.
 *
 * "O mais próximo" seria o erro sutil: no meio de um quadro, o vizinho da frente
 * pode estar mais perto em milissegundos — e ainda assim ser um quadro do
 * FUTURO, que o olho não deveria estar vendo.
 */
export function pickFrameTs(tsList: number[], targetUs: number): number | null {
  if (tsList.length === 0) return null;
  let best: number | null = null;
  for (const ts of tsList) {
    if (ts <= targetUs && (best === null || ts > best)) best = ts;
  }
  // Nenhum começou ainda (alvo antes do 1º quadro): mostra o primeiro.
  return best ?? tsList.reduce((a, b) => Math.min(a, b));
}

/** O `VideoDecoder` existe? Ver o gotcha do SecureContext no topo do arquivo. */
export function hasWebCodecs(): boolean {
  return typeof window !== "undefined" && typeof window.VideoDecoder === "function";
}

/** Containers que o demuxer abre. O resto degrada pro `<video>` — e o app avisa. */
const MP4_EXT = ["mp4", "m4v", "mov"];

export function canDecodeExactly(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return hasWebCodecs() && MP4_EXT.includes(ext);
}

/**
 * Um arquivo aberto: tabela de amostras + decodificador, prontos pra pular pra
 * qualquer quadro. Um por arquivo, reaproveitado — abrir custa uma leitura do
 * arquivo inteiro e não se faz isso a cada seta.
 */
export class FrameSource {
  private file: MP4File | null = null;
  private samples: MP4Sample[] = [];
  private meta: SampleMeta[] = [];
  private decoder: VideoDecoder | null = null;
  private config: VideoDecoderConfig | null = null;
  private ready: Promise<void> | null = null;
  /** Serializa os seeks: dois decodes no mesmo `VideoDecoder` se atropelam. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private url: string) {}

  /** Duração do vídeo em µs (o que a tabela de amostras diz). */
  get durationUs(): number {
    const last = this.meta[this.meta.length - 1];
    return last ? last.tsUs + last.durUs : 0;
  }

  private async open(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const res = await fetch(this.url);
      // **Conferir o `ok` não é paranoia — é o bug que já aconteceu aqui.**
      // O asset protocol do Tauri responde com ERRO (não com o vídeo) pra
      // caminho fora do `assetProtocol.scope`. Sem este cheque, o corpo do erro
      // ia como "mp4" pro demuxer, o `onReady` nunca disparava, e a promessa
      // ficava pendurada PRA SEMPRE — travando a fila de seeks junto. Falhar
      // aqui deixa a prévia degradar pro `<video>`, que é o certo.
      if (!res.ok) throw new Error(`asset ${res.status}`);
      const buf = (await res.arrayBuffer()) as MP4ArrayBuffer;
      // O mp4box quer saber onde este pedaço começa no arquivo. A gente lê tudo
      // de uma vez (é um arquivo local, não um streaming) — então é 0.
      buf.fileStart = 0;

      const file = MP4Box.createFile();
      this.file = file;

      // Nada de `new Promise` em volta do mp4box: com o arquivo INTEIRO em mãos
      // ele chama `onReady`/`onSamples` de forma SÍNCRONA, ainda dentro do
      // `appendBuffer`/`start`. Envolver isso numa promessa só cria um jeito de
      // travar pra sempre quando o callback não vem (arquivo corrompido, ou o
      // 403 acima). Assim, "não veio" é uma checagem depois da linha, não uma
      // espera infinita.
      let track: MP4Track | null = null;
      let failed: unknown = null;
      file.onReady = (info) => {
        track = info.videoTracks?.[0] ?? null;
      };
      file.onError = (e) => {
        failed = e;
      };
      file.appendBuffer(buf);
      file.flush();

      if (failed) throw new Error(String(failed));
      // O TS não enxerga a escrita dentro do callback síncrono.
      const t = track as MP4Track | null;
      if (!t) throw new Error("container não abriu (ou não tem trilha de vídeo)");

      const samples: MP4Sample[] = [];
      file.onSamples = (_id, _user, s) => samples.push(...s);
      // `nbSamples: Infinity` = entrega tudo de uma vez; sem isso o mp4box
      // fatia em lotes de 1000 e a tabela chega pela metade.
      file.setExtractionOptions(t.id, null, { nbSamples: Infinity });
      file.start();
      if (samples.length === 0) throw new Error("sem amostras");

      this.samples = samples;
      this.meta = samples.map((s) => ({
        // cts/duration vêm no timescale da TRILHA; o WebCodecs fala µs. Sem esta
        // conversão os timestamps saem em outra escala e nada casa.
        tsUs: Math.round((s.cts / s.timescale) * 1e6),
        durUs: Math.round((s.duration / s.timescale) * 1e6),
        isSync: !!s.is_sync,
      }));

      this.config = {
        codec: t.codec,
        codedWidth: t.video?.width ?? t.track_width,
        codedHeight: t.video?.height ?? t.track_height,
        // A `description` (o avcC/hvcC) é o manual de instruções do fluxo — SPS
        // e PPS. Sem ela o decodificador não sabe ler nem o primeiro quadro e
        // estoura com um erro que não explica nada.
        description: descriptionFor(file, t.id),
        // **`prefer-software` não é preguiça — é o que FUNCIONA, medido.**
        //
        // Com aceleração de hardware (o `no-preference` padrão) neste WebView2 o
        // `flush()` **nunca resolve**: zero quadros na saída, o callback de
        // `error` não dispara, e a promessa fica pendurada pra sempre. Não há
        // erro pra tratar — há um silêncio.
        //
        // E o pior: `VideoDecoder.isConfigSupported()` responde
        // `supported: true` pra essa mesma config. **A sonda de capacidade
        // mente** — do mesmo jeito que o `ffmpeg -encoders` lista nvenc numa
        // máquina que não tem nvenc. Só decodificar de verdade prova.
        //
        // O custo é nenhum no que este decodificador faz: UM quadro, com o
        // playhead parado. Quem toca o vídeo é o `<video>`, e esse usa o
        // pipeline de mídia do sistema (com hardware) normalmente.
        hardwareAcceleration: "prefer-software",
      };
    })();
    return this.ready;
  }

  /**
   * O quadro exato do instante pedido (µs no tempo do ARQUIVO).
   *
   * Quem chama **precisa dar `close()`** no frame: `VideoFrame` segura memória
   * de vídeo de verdade, fora do alcance do coletor de lixo. Vazar isto trava a
   * decodificação depois de algumas dezenas de seeks.
   */
  async frameAt(targetUs: number): Promise<VideoFrame | null> {
    // Na fila: cada seek espera o anterior. Segurar setas repetidas dispara
    // vários decodes, e dois decodes no mesmo `VideoDecoder` viram lixo na tela.
    const run = this.queue.then(() => this.decodeAt(targetUs));
    this.queue = run.catch(() => {});
    return run;
  }

  private async decodeAt(targetUs: number): Promise<VideoFrame | null> {
    await this.open();
    if (!this.config) return null;

    const range = pickDecodeRange(this.meta, targetUs);
    if (!range) return null;

    const frames: VideoFrame[] = [];
    const decoder = new VideoDecoder({
      output: (f) => frames.push(f),
      error: () => {
        /* o `flush()` abaixo rejeita e quem chamou degrada pro <video> */
      },
    });
    this.decoder = decoder;
    decoder.configure(this.config);

    try {
      for (let i = range.start; i <= range.end; i++) {
        const s = this.samples[i];
        decoder.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: this.meta[i].tsUs,
            duration: this.meta[i].durUs,
            data: s.data,
          }),
        );
      }
      // Sem o flush o decodificador segura os últimos quadros esperando mais
      // entrada — e o quadro pedido nunca sai.
      //
      // A corrida contra o relógio é cinto de segurança, não paranoia: já vimos
      // este `flush()` **pendurar pra sempre, sem erro nenhum** (era a aceleração
      // por hardware — ver o `prefer-software` lá em cima). Como um `flush()`
      // que nunca volta trava a FILA inteira de seeks, e aí a prévia morre de vez
      // em vez de degradar, aqui ninguém espera pra sempre.
      await Promise.race([
        decoder.flush(),
        new Promise((_r, rej) => setTimeout(() => rej(new Error("flush travou")), 5000)),
      ]);
    } catch {
      for (const f of frames) f.close();
      decoder.close();
      this.decoder = null;
      return null;
    }

    const wantTs = pickFrameTs(
      frames.map((f) => f.timestamp),
      targetUs,
    );
    let picked: VideoFrame | null = null;
    for (const f of frames) {
      // O escolhido é o único que sobrevive; o resto do GOP se fecha aqui.
      if (picked === null && f.timestamp === wantTs) picked = f;
      else f.close();
    }
    decoder.close();
    this.decoder = null;
    return picked;
  }

  /** Fecha tudo. O `FrameSource` some quando o clipe sai da prévia. */
  dispose(): void {
    try {
      if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    } catch {
      /* já estava fechado */
    }
    try {
      // Para a extração: o mp4box segura a tabela de amostras do arquivo INTEIRO
      // (num vídeo longo, muitos MB) e não a solta sozinho.
      this.file?.stop();
    } catch {
      /* nunca chegou a abrir */
    }
    this.decoder = null;
    this.file = null;
    this.samples = [];
    this.meta = [];
  }
}

/**
 * Extrai o avcC/hvcC/vpcC/av1C da trilha — a `description` do decodificador.
 *
 * O `.slice(8)` tira os 8 bytes de cabeçalho do box (tamanho + tipo): o
 * WebCodecs quer o CONTEÚDO, não a caixa. Passar a caixa inteira é o erro
 * clássico, e o sintoma é um `configure()` que aceita tudo e um `decode()` que
 * falha sem dizer por quê.
 */
function descriptionFor(file: MP4File, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId);
  for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (!box) continue;
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer.slice(8));
  }
  // VP8/VP9 em mp4 às vezes não trazem box de config — o codec se descreve
  // sozinho e `undefined` é a resposta certa, não um erro.
  return undefined;
}
