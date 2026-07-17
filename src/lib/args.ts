/**
 * O cérebro do export: decidir o CAMINHO e montar os argumentos do ffmpeg.
 *
 * TS puro, sem React e sem Tauri — porque é aqui que mora o risco do app. Um
 * argumento errado do ffmpeg não dá erro de compilação: dá vídeo preto, áudio
 * fora de sincronia ou uma hora de espera. Então isto se testa sem abrir janela.
 * (Regra da casa, gotcha #7: os args se montam no FRONT; o Rust só resolve o
 * binário e move bytes.)
 *
 * ─── Os dois caminhos ────────────────────────────────────────────────────────
 *
 * **`-c copy` (concat demuxer)** — corta e junta MOVENDO PACOTES, sem decodificar
 * nada. É instantâneo e não perde um bit de qualidade. É o truque que faz o app
 * parecer rápido. Só que ele tem um preço fixo: **o começo de cada corte precisa
 * cair num quadro-chave**. Um quadro que não é chave só existe como "diferença"
 * em relação a um anterior — começar nele é impossível sem decodificar, e por
 * isso o ffmpeg silenciosamente escorrega pro quadro-chave anterior. Quem não
 * confere isso entrega um corte que "pulou" um segundo e não sabe por quê.
 *
 * **`filter_complex` (recodificar)** — decodifica, corta no quadro exato e
 * codifica de novo. Sempre funciona, sempre é lento, sempre perde um tico de
 * qualidade (é geração nova). É o plano B honesto.
 *
 * O `planExport()` escolhe sozinho e devolve o PORQUÊ — a UI traduz esse porquê
 * em linguagem de gente. "Recodificado" sem explicação é o tipo de coisa que faz
 * o usuário achar que o app é lento; "recodificado porque o corte em 4,3 s não
 * caía num quadro-chave" é informação.
 */

/** Um clipe, do jeito que o export precisa: janela sobre um arquivo. */
export interface ExportClip {
  path: string;
  /** Início da janela no arquivo-fonte, em ms. */
  srcIn: number;
  /** Fim da janela (exclusivo), em ms. */
  srcOut: number;
}

/** O que sabemos de cada arquivo-fonte (sonda + sonda de quadros-chave). */
export interface SourceInfo {
  /** Instantes de quadro-chave do arquivo, em ms, ORDENADOS. Vazio = não sabemos. */
  keyframesMs: number[];
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string | null;
}

/**
 * Por que o export pegou o caminho que pegou.
 *
 * É um CÓDIGO + dados, nunca uma frase: quem fala com o usuário é a UI, no
 * idioma dela. Frase montada aqui vazaria português na tela de quem usa em
 * espanhol — o mesmo motivo pelo qual os erros do Rust são códigos.
 */
export type PlanReason =
  /** Todo corte já caía num quadro-chave. O caso feliz: instantâneo e sem perda. */
  | { code: "copy-exact" }
  /** Caiu perto e o usuário deixou encostar. `maxShiftMs` = o maior desvio real. */
  | { code: "copy-snapped"; maxShiftMs: number }
  /** Um corte não cai em quadro-chave (e não pôde/quis encostar). */
  | { code: "encode-off-keyframe"; atMs: number; nearestMs: number; path: string }
  /** Clipes de formatos diferentes: o concat demuxer exige codec/tamanho iguais. */
  | { code: "encode-mixed-format" }
  /** A sonda de quadros-chave não respondeu — sem saber, não dá pra arriscar. */
  | { code: "encode-no-keyframe-data"; path: string };

export interface ExportPlan {
  kind: "copy" | "encode";
  /** Os clipes JÁ RESOLVIDOS (no caminho copy, com o `srcIn` encostado). */
  clips: ExportClip[];
  reason: PlanReason;
}

export interface PlanOptions {
  /**
   * Deixa encostar um corte no quadro-chave vizinho pra ganhar o `-c copy`.
   * **Padrão `false`, de propósito**: encostar MEXE no corte do usuário, e mexer
   * calado no trabalho dele pra ganhar tempo é troca que ele tem que escolher.
   * A UI oferece com o desvio à mostra.
   */
  snap?: boolean;
  /** O quanto se pode encostar, em ms, quando `snap` está ligado. */
  snapToleranceMs?: number;
}

/** Encostar até aqui é o padrão do checkbox da UI: meio segundo é perceptível
 *  mas não desmonta uma cena. Acima disso não é "encostar", é outro corte. */
export const DEFAULT_SNAP_TOLERANCE_MS = 500;

/**
 * Instantes que o ffprobe considera quadro-chave, a partir do CSV cru de
 * `-skip_frame nokey -show_entries frame=pts_time -of csv`.
 *
 * O Rust entrega o texto cru e o parse mora aqui, testado. As linhas vêm como
 * `frame,0.000000` — e o mundo real é mais sujo que a documentação:
 *
 * - **`frame,0.000000,` — com vírgula sobrando no fim.** Saída LITERAL do
 *   ffprobe n-125648 no primeiro quadro (verificado, não suposto). Quem pega "o
 *   campo depois da última vírgula" recebe string vazia e **perde justo o
 *   quadro-chave do instante 0** — o mais importante que existe, o que decide se
 *   um clipe não-aparado ganha o `-c copy`. Por isso a varredura procura o
 *   primeiro campo NUMÉRICO, em vez de contar vírgulas.
 * - `frame,N/A` (quadro sem timestamp declarado): `parseFloat` devolveria `NaN`,
 *   o `NaN` entraria na lista, e toda comparação da busca binária com `NaN` é
 *   `false` — o app decidiria o caminho do export no escuro.
 * - linha vazia no fim, e ordem não garantida em arquivo com B-frame.
 *
 * Daí: filtra, ordena, deduplica.
 */
export function parseKeyframesCsv(csv: string): number[] {
  const out: number[] = [];
  for (const raw of csv.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Primeiro campo que É um número. O `frame` da frente é o nome da seção; o
    // que vier depois de vírgula sobrando é vazio e se ignora sozinho.
    let s: number | null = null;
    for (const f of line.split(",")) {
      const field = f.trim();
      if (!field || field === "N/A" || field === "frame") continue;
      const n = Number(field);
      if (Number.isFinite(n)) {
        s = n;
        break;
      }
    }
    if (s === null || s < 0) continue;
    out.push(Math.round(s * 1000));
  }
  out.sort((a, b) => a - b);
  // Dedup: o mesmo pts pode aparecer duas vezes em container remuxado.
  return out.filter((v, i) => i === 0 || v !== out[i - 1]);
}

/**
 * O quadro-chave mais próximo de `t` (busca binária — a lista de um filme longo
 * tem milhares de entradas e isto roda a cada replaneamento da UI).
 * `null` só quando não há lista nenhuma.
 */
export function nearestKeyframe(keyframesMs: number[], t: number): number | null {
  if (keyframesMs.length === 0) return null;
  let lo = 0;
  let hi = keyframesMs.length - 1;
  if (t <= keyframesMs[lo]) return keyframesMs[lo];
  if (t >= keyframesMs[hi]) return keyframesMs[hi];
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (keyframesMs[mid] <= t) lo = mid;
    else hi = mid;
  }
  // `lo` é o anterior e `hi` o seguinte: devolve o mais perto (empate = o anterior,
  // que é o lado pra onde o ffmpeg escorregaria de qualquer jeito).
  return t - keyframesMs[lo] <= keyframesMs[hi] - t ? keyframesMs[lo] : keyframesMs[hi];
}

/**
 * Tolerância de "é o mesmo quadro": meio quadro. Abaixo disso o corte e o
 * quadro-chave são o MESMO quadro, e a diferença é só arredondamento de ms —
 * encostar aqui não mexe em nada que exista.
 */
function sameFrameTol(fps: number): number {
  return fps > 0 ? 1000 / fps / 2 : 17;
}

/** O concat demuxer cola PACOTES: exige mesmo codec e mesma geometria. */
function compatible(a: SourceInfo, b: SourceInfo): boolean {
  return (
    a.videoCodec === b.videoCodec &&
    a.width === b.width &&
    a.height === b.height &&
    a.hasAudio === b.hasAudio &&
    a.audioCodec === b.audioCodec
  );
}

/**
 * Decide o caminho do export. **Função pura** — é o coração testável do app.
 *
 * A pergunta é só uma: **todo corte começa num quadro-chave?** O FIM do corte
 * não entra na conta e isso não é descuido: o `-c copy` para de escrever pacote
 * quando chega no fim pedido, e todo quadro até lá tem as referências dele
 * dentro do trecho. Quem exige quadro-chave no fim recodifica à toa metade das
 * vezes.
 */
export function planExport(
  clips: ExportClip[],
  sources: Record<string, SourceInfo>,
  opts: PlanOptions = {},
): ExportPlan {
  const snap = opts.snap ?? false;
  const tol = opts.snapToleranceMs ?? DEFAULT_SNAP_TOLERANCE_MS;

  const encode = (reason: PlanReason): ExportPlan => ({ kind: "encode", clips, reason });

  // Formatos misturados: nem adianta olhar quadro-chave, o concat demuxer não
  // cola isso. (Um clipe só nunca é "misturado" — não há com o que misturar.)
  if (clips.length > 1) {
    const first = sources[clips[0].path];
    for (const c of clips) {
      const s = sources[c.path];
      if (!first || !s || !compatible(first, s)) return encode({ code: "encode-mixed-format" });
    }
  }

  const resolved: ExportClip[] = [];
  let maxShift = 0;

  for (const c of clips) {
    const s = sources[c.path];
    // Sem lista de quadros-chave estaríamos CHUTANDO que o corte cai bem. Um
    // chute errado aqui não dá erro: dá um vídeo que começa no lugar errado, e
    // o usuário só descobre assistindo. Recodificar é mais lento e está certo.
    if (!s || s.keyframesMs.length === 0) {
      return encode({ code: "encode-no-keyframe-data", path: c.path });
    }

    const kf = nearestKeyframe(s.keyframesMs, c.srcIn);
    if (kf === null) return encode({ code: "encode-no-keyframe-data", path: c.path });

    const dist = Math.abs(kf - c.srcIn);
    const exact = dist <= sameFrameTol(s.fps);

    if (!exact && !(snap && dist <= tol)) {
      return encode({ code: "encode-off-keyframe", atMs: c.srcIn, nearestMs: kf, path: c.path });
    }

    // Encostou de verdade? Só conta como desvio o que o olho poderia ver: o
    // ajuste de meio quadro é o mesmo quadro, não é um corte movido.
    if (!exact) maxShift = Math.max(maxShift, dist);
    // A janela anda inteira? NÃO: só o começo. Mexer no fim junto encurtaria ou
    // esticaria o clipe sem ninguém pedir — o usuário aparou aquele fim.
    resolved.push({ ...c, srcIn: kf });
  }

  // Encostar não pode virar clipe vazio/invertido (corte curtíssimo perto de um
  // quadro-chave à frente). Se virou, o encosto não serve: recodifica.
  for (const c of resolved) {
    if (c.srcOut - c.srcIn <= 0) {
      const orig = clips[resolved.indexOf(c)];
      return encode({
        code: "encode-off-keyframe",
        atMs: orig.srcIn,
        nearestMs: c.srcIn,
        path: c.path,
      });
    }
  }

  return {
    kind: "copy",
    clips: resolved,
    reason: maxShift > 0 ? { code: "copy-snapped", maxShiftMs: maxShift } : { code: "copy-exact" },
  };
}

/* ------------------------------------------------------------------ */
/* Montagem dos argumentos                                             */
/* ------------------------------------------------------------------ */

/** Segundos com 3 casas — o ffmpeg aceita e é o que a gente enxerga no log. */
export function secs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

/**
 * A lista do concat demuxer — o caminho `-c copy` inteiro, num arquivo de texto.
 *
 * ─── Por que `inpoint`/`outpoint`, e não recortar antes ──────────────────────
 *
 * O jeito "óbvio" de copiar cortando é em duas etapas: recorta cada trecho pra
 * um arquivo temporário (`-ss`/`-t -c copy`) e depois cola os temporários. Foi o
 * primeiro desenho daqui, e **a medição derrubou** (ffmpeg n-125648, vídeo de
 * teste com GOP de 1 s):
 *
 * | pedido | duas etapas | inpoint/outpoint |
 * |---|---|---|
 * | 2 trechos, 5,000 s | 5,234 s | **5,090 s** |
 *
 * O demuxer faz os dois cortes numa passada só, e ganha em tudo:
 * - **um ffmpeg em vez de N+1** (a barra de progresso vira uma coisa só, honesta);
 * - **escreve o vídeo UMA vez.** As duas etapas gravam cada byte duas vezes —
 *   num export de 10 min isso é o dobro de disco e o dobro de espera, gasto pra
 *   nada;
 * - é mais exato, como a tabela mostra.
 *
 * ─── O que o `-c copy` NÃO consegue entregar (e é honesto saber) ─────────────
 *
 * A saída fica ~0,1 s mais longa que o pedido (3,000 s pedidos → 3,141 s). Não é
 * bug, é o preço da cópia sem perda, e tem dois donos:
 * - o vídeo sai em pacotes inteiros (2 quadros a mais no fim);
 * - o áudio vem em blocos de ~21 ms que não se cortam ao meio sem recodificar,
 *   então entra um pedacinho de som de antes do corte.
 *
 * Medido, não suposto — e é por isso que o `filter_complex` continua existindo:
 * quem precisa do corte no quadro exato paga o re-encode. As duas alternativas
 * ao `-ss` de entrada foram testadas e são PIORES: seek de saída (`-ss` depois
 * do `-i`) chegou a jogar fora **um segundo inteiro de vídeo** (a imagem só
 * aparecia no meio do trecho).
 *
 * ─── O escape ───────────────────────────────────────────────────────────────
 *
 * A lição que o LocalMedia já pagou (tem teste lá). O demuxer lê `file '...'` e
 * a ÚNICA saída de dentro das aspas simples é `'\''`. Um vídeo chamado
 * `it's.mp4` sem isso fecha a aspa no meio do caminho, e o ffmpeg vai reclamar
 * de um arquivo que ninguém pediu. As contrabarras do Windows viram barras
 * porque o demuxer trata `\` como escape.
 */
export function concatListBody(clips: ExportClip[]): string {
  const lines: string[] = [];
  for (const c of clips) {
    const p = c.path.replace(/\\/g, "/").replace(/'/g, "'\\''");
    lines.push(`file '${p}'`);
    lines.push(`inpoint ${secs(c.srcIn)}`);
    lines.push(`outpoint ${secs(c.srcOut)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Roda a lista acima.
 *
 * `-safe 0` porque a lista tem caminho absoluto (com `C:\` e com acento) — o
 * modo seguro do demuxer recusa isso. A lista é escrita por nós, num tmp nosso,
 * com o caminho que o próprio app acabou de gerar: não há entrada de terceiro
 * pra "proteger".
 *
 * `-avoid_negative_ts make_zero`: cada trecho começa num quadro-chave lá do meio
 * do arquivo, com o timestamp de lá. Sem zerar, o filme sai com um buraco no
 * começo e o player fica "esperando" antes da primeira imagem.
 */
export function concatArgs(listPath: string, out: string, hasAudio: boolean): string[] {
  return [
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-map",
    "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0"] : ["-an"]),
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    out,
  ];
}

export interface EncodeOptions {
  /** CRF do x264: 18 ≈ visualmente sem perda, 23 = padrão. 20 é o nosso meio. */
  crf?: number;
  preset?: string;
}

/**
 * O caminho lento e infalível: decodificar, cortar no quadro exato, colar e
 * codificar de novo.
 *
 * Uma entrada `-i` por CLIPE, mesmo repetindo o arquivo. Dois clipes do mesmo
 * vídeo podiam sair de uma entrada só, com `split` — mas aí o grafo passa a
 * depender de quantas vezes cada arquivo aparece, e vira o tipo de código que
 * ninguém consegue ler nem testar. Reabrir um arquivo custa quase nada.
 *
 * O `concat` (filtro) é exigente: só cola trechos de mesmo tamanho, mesmo SAR e
 * com o mesmo número de trilhas. Por isso cada trecho é normalizado ANTES —
 * `scale`+`pad` (cabendo inteiro, com barra, nunca esticado), `setsar=1`, `fps`.
 * E áudio: se UM clipe é mudo e outro não, o filtro se recusa a colar. A saída
 * honesta é silêncio (`anullsrc`) no lugar do que não existe — não perder o
 * áudio dos outros clipes por causa de um mudo.
 */
export function encodeArgs(
  clips: ExportClip[],
  sources: Record<string, SourceInfo>,
  out: string,
  opts: EncodeOptions = {},
): string[] {
  const crf = opts.crf ?? 20;
  const preset = opts.preset ?? "veryfast";

  const infos = clips.map((c) => sources[c.path]);
  // Alvo: a geometria do PRIMEIRO clipe (é o que o usuário vê como "o vídeo") e
  // a MAIOR taxa de quadros (baixar a taxa de alguém joga quadro fora de vez;
  // subir só repete).
  const w = infos[0]?.width || 1920;
  const h = infos[0]?.height || 1080;
  const fps = Math.max(...infos.map((i) => i?.fps || 0), 0) || 30;
  // Só faz sentido ter áudio na saída se ALGUM clipe tiver.
  const anyAudio = infos.some((i) => i?.hasAudio);

  const args: string[] = [];
  for (const c of clips) args.push("-i", c.path);

  // Uma fonte de silêncio por clipe mudo — cada uma com sua duração, sem
  // `asplit` no grafo. `-t` na ENTRADA porque o anullsrc é infinito.
  const silentIdx = new Map<number, number>();
  if (anyAudio) {
    clips.forEach((c, i) => {
      if (infos[i]?.hasAudio) return;
      silentIdx.set(i, clips.length + silentIdx.size);
      args.push(
        "-f",
        "lavfi",
        "-t",
        secs(c.srcOut - c.srcIn),
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
      );
    });
  }

  const parts: string[] = [];
  const labels: string[] = [];

  clips.forEach((c, i) => {
    const s = infos[i];
    const vf = [
      // `trim` corta no tempo do ARQUIVO (start/end são do fonte) e o
      // `setpts=PTS-STARTPTS` rebobina o trecho pro zero. Sem essa rebobinada o
      // concat recebe trechos que "começam" aos 30 s e monta um filme com
      // buracos — é o erro clássico do filter_complex.
      `trim=start=${secs(c.srcIn)}:end=${secs(c.srcOut)}`,
      "setpts=PTS-STARTPTS",
    ];
    if (!s || s.width !== w || s.height !== h) {
      vf.push(
        `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
      );
    }
    vf.push("setsar=1", `fps=${fps}`);
    parts.push(`[${i}:v:0]${vf.join(",")}[v${i}]`);
    labels.push(`[v${i}]`);

    if (anyAudio) {
      const src = s?.hasAudio ? `[${i}:a:0]` : `[${silentIdx.get(i)}:a:0]`;
      const af = s?.hasAudio
        ? [`atrim=start=${secs(c.srcIn)}:end=${secs(c.srcOut)}`, "asetpts=PTS-STARTPTS"]
        : ["asetpts=PTS-STARTPTS"];
      // Taxa e layout iguais em todo mundo, senão o concat recusa.
      af.push("aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo");
      parts.push(`${src}${af.join(",")}[a${i}]`);
      labels.push(`[a${i}]`);
    }
  });

  const n = clips.length;
  parts.push(
    `${labels.join("")}concat=n=${n}:v=1:a=${anyAudio ? 1 : 0}[outv]${anyAudio ? "[outa]" : ""}`,
  );

  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[outv]",
    ...(anyAudio ? ["-map", "[outa]"] : []),
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    ...(anyAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    // `+faststart`: move o índice pro começo do arquivo. Sem isso um mp4 só
    // começa a tocar depois de baixar inteiro — e o usuário vai mandar o vídeo
    // pra alguém, não só assistir no disco.
    "-movflags",
    "+faststart",
    out,
  );
  return args;
}

/** Argumentos da sonda de quadros-chave (o ffprobe, não o ffmpeg).
 *
 *  `-skip_frame nokey` faz o decodificador DESCARTAR todo quadro que não é
 *  chave: em vez de percorrer 100 mil quadros ele toca nos poucos que importam.
 *  Sem isso, "quais são os quadros-chave?" custa quase um play do filme inteiro.
 */
export function keyframeProbeArgs(path: string): string[] {
  return [
    "-v",
    "quiet",
    "-select_streams",
    "v:0",
    "-skip_frame",
    "nokey",
    "-show_entries",
    "frame=pts_time",
    "-of",
    "csv",
    path,
  ];
}
