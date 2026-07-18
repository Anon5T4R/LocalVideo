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
  | { code: "encode-no-keyframe-data"; path: string }
  /** A timeline usa recursos da v0.2 (2ª trilha, transição, título, fade,
   *  volume): não é concat, é o compilador de `filter_complex`. */
  | { code: "encode-multitrack" }
  /** O usuário escolheu um preset que recodifica (resolução/qualidade cravadas):
   *  mesmo uma timeline simples sai pelo compilador. */
  | { code: "encode-preset"; preset: ExportPresetId };

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

/* ================================================================== */
/* v0.2 — o COMPILADOR timeline → filter_complex                       */
/* ================================================================== */

/**
 * A grande mudança da v0.2. A v0.1 exportava por `concat` (clipes em fila).
 * Multitrilha, transição, título e fade **não são concat** — são um GRAFO. Este
 * bloco é, no fundo, um pequeno compilador: recebe a timeline (posições, trilhas,
 * títulos, áudio) e cospe o `-filter_complex` que o ffmpeg entende. É o maior
 * risco da fase, então é TS puro e cada operador tem teste cravando o vetor.
 *
 * ─── A ideia central: compor por OVERLAY sobre um fundo preto ────────────────
 *
 * Em vez de tentar casar `xfade`+`concat`+`overlay` num grafo que ninguém lê, a
 * gente pinta tudo por cima de um `color=black` do tamanho do filme:
 *
 * - **posição no tempo** (`startMs`) = deslocar o PTS do clipe e ligar o overlay
 *   só na janela `[start,end)` (`enable='between(...)'`). Buraco entre clipes =
 *   o preto do fundo aparece. Sai de graça.
 * - **trilhas empilhadas** = overlays em cima de overlays, de baixo pra cima.
 * - **crossfade** = o clipe de cima ENTRA com alfa (fade-in no canal alfa) sobre
 *   a sobreposição; o de baixo continua aparecendo por baixo. O olho vê um
 *   dissolve. Não precisa de `xfade` — a sobreposição É a transição (ver o
 *   modelo em `timeline.ts`).
 * - **título** = `drawtext` direto no acumulado, ligado na janela do título.
 *
 * O áudio é a parte simétrica: cada clipe com som vira um fluxo atrasado pro seu
 * `startMs` (`adelay`), com volume/fade, e todos entram num `amix`. Sobreposição
 * na mesma trilha vira fade cruzado (o de baixo esvai, o de cima cresce), casando
 * com o crossfade do vídeo.
 */

import {
  clipSpeed,
  type Clip,
  type ColorAdjust,
  type CropRect,
  type Keyframe,
  type Timeline,
  type TransitionKind,
} from "./timeline";

/** O que o compilador precisa saber de cada arquivo-fonte. Reusa o `SourceInfo`
 *  de cima — width/height/fps/hasAudio bastam pra normalizar e decidir o áudio. */
export type MediaSources = Record<string, SourceInfo>;

/* ------------------------------------------------------------------ */
/* Presets de export (v0.3)                                            */
/* ------------------------------------------------------------------ */

export type ExportPresetId = "source" | "youtube1080" | "vertical" | "whatsapp" | "quality";

/**
 * Um preset crava as decisões de saída (resolução/fps/codec/qualidade/áudio) num
 * nome que o usuário entende ("YouTube 1080p") em vez de campos técnicos soltos.
 * `width/height/fps = 0` significa "mantém o que a composição já tem" (a
 * resolução do 1º clipe, o maior fps) — é o caso do "source" e do "qualidade".
 */
export interface ExportPreset {
  id: ExportPresetId;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  crf: number;
  x264preset: string;
  audioBitrate: string;
  /** Extensão/contêiner de saída sugerido. */
  container: string;
  /** Precisa recodificar (não cabe no `-c copy`)? Só "source" pode ser copiado. */
  reencode: boolean;
}

export const EXPORT_PRESETS: Record<ExportPresetId, ExportPreset> = {
  // O padrão: mantém tudo do fonte e deixa o `planExport` escolher copy/encode.
  source: {
    id: "source", width: 0, height: 0, fps: 0, vcodec: "libx264", crf: 20,
    x264preset: "veryfast", audioBitrate: "192k", container: "mp4", reencode: false,
  },
  // 1920×1080, qualidade alta de plataforma.
  youtube1080: {
    id: "youtube1080", width: 1920, height: 1080, fps: 0, vcodec: "libx264", crf: 20,
    x264preset: "medium", audioBitrate: "192k", container: "mp4", reencode: true,
  },
  // Vertical 9:16 (Reels/Shorts/Stories).
  vertical: {
    id: "vertical", width: 1080, height: 1920, fps: 0, vcodec: "libx264", crf: 21,
    x264preset: "medium", audioBitrate: "160k", container: "mp4", reencode: true,
  },
  // Menor: mesma resolução, CRF alto + áudio menor = arquivo pequeno pra mandar.
  whatsapp: {
    id: "whatsapp", width: 0, height: 0, fps: 30, vcodec: "libx264", crf: 30,
    x264preset: "veryfast", audioBitrate: "96k", container: "mp4", reencode: true,
  },
  // Máxima qualidade (quase sem perda): mantém resolução/fps, CRF baixíssimo.
  quality: {
    id: "quality", width: 0, height: 0, fps: 0, vcodec: "libx264", crf: 14,
    x264preset: "slow", audioBitrate: "256k", container: "mp4", reencode: true,
  },
};

/** Opções de saída (mesmos padrões do `encodeArgs`). */
export interface CompileOptions {
  crf?: number;
  preset?: string;
  /** Caminho ABSOLUTO da fonte embarcada (o ffmpeg não acha fonte sozinho no
   *  Windows). Obrigatório se houver título; o Rust resolve e passa. */
  fontPath?: string;
  /** Preset de export: crava resolução/fps/codec/qualidade. Ausente = "source". */
  exportPreset?: ExportPreset;
}

/* ------------------------------------------------------------------ */
/* Filtros por clipe (v0.3): crop, cor, PiP, velocidade, envelopes      */
/* ------------------------------------------------------------------ */

/** O recorte é "cheio" (não faz nada)? Evita meter um `crop` que não corta. */
function isFullCrop(c: CropRect): boolean {
  return c.x <= 0.0001 && c.y <= 0.0001 && c.w >= 0.9999 && c.h >= 0.9999;
}

/** `crop` em pixels do fonte, expresso como fração de `iw`/`ih` (o ffmpeg avalia
 *  a expressão — assim o corte independe da resolução exata do arquivo). */
function cropExpr(c: CropRect): string {
  const f = (n: number) => Math.max(0, Math.min(1, n)).toFixed(4);
  return `crop=iw*${f(c.w)}:ih*${f(c.h)}:iw*${f(c.x)}:ih*${f(c.y)}`;
}

/** Cor neutra (nada a fazer)? */
function isNeutralColor(c: ColorAdjust): boolean {
  return Math.abs(c.brightness) < 0.001 && Math.abs(c.contrast - 1) < 0.001 && Math.abs(c.saturation - 1) < 0.001;
}

/** `eq` do ffmpeg: brilho (aditivo), contraste e saturação (multiplicativos). */
function eqExpr(c: ColorAdjust): string {
  const f = (n: number) => n.toFixed(3);
  return `eq=brightness=${f(c.brightness)}:contrast=${f(c.contrast)}:saturation=${f(c.saturation)}`;
}

/**
 * Corrente de `atempo` pra uma velocidade de áudio. O `atempo` só aceita fator
 * 0.5..100 por instância — abaixo de 0.5 (câmera lenta) é preciso encadear
 * (0.25 = 0.5×0.5). Acima de 1 um instância só resolve toda a faixa até 4×. É o
 * gotcha que a spec pediu pra encadear.
 */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  // Câmera lenta forte: quebra em fatores de 0.5 até caber.
  while (s < 0.5 - 1e-6) {
    out.push("atempo=0.5");
    s /= 0.5;
  }
  // Acelerar forte: quebra em fatores de 2 (defensivo; 4× já cabe em um só).
  while (s > 2 + 1e-6) {
    out.push("atempo=2.0");
    s /= 2;
  }
  out.push(`atempo=${s.toFixed(6)}`);
  return out;
}

/**
 * Expressão piecewise-linear de um envelope no tempo. `pts` são {t (fração 0..1),
 * v}; `durSec` é a duração do clipe em segundos; `tvar` é a variável de tempo do
 * filtro (`T` no geq de vídeo, `t` no volume de áudio). Antes do 1º ponto vale o
 * 1º valor; depois do último, o último; entre pontos, interpola linear.
 */
export function envelopeExpr(pts: Keyframe[], durSec: number, tvar: string): string {
  const p = [...pts].sort((a, b) => a.t - b.t);
  if (p.length === 0) return "1";
  const f = (n: number) => n.toFixed(4);
  if (p.length === 1) return f(p[0].v);
  // De trás pra frente: o "senão" mais interno é o último valor (fallthrough).
  let expr = f(p[p.length - 1].v);
  for (let i = p.length - 2; i >= 0; i--) {
    const ta = p[i].t * durSec;
    const tb = p[i + 1].t * durSec;
    const seg =
      tb > ta
        ? `(${f(p[i].v)}+(${f(p[i + 1].v - p[i].v)})*(${tvar}-${f(ta)})/${f(tb - ta)})`
        : f(p[i + 1].v);
    expr = `if(lt(${tvar}\\,${f(tb)})\\,${seg}\\,${expr})`;
  }
  // Antes do 1º ponto: o 1º valor.
  expr = `if(lt(${tvar}\\,${f(p[0].t * durSec)})\\,${f(p[0].v)}\\,${expr})`;
  return expr;
}

/** O `geq` que pinta o canal alfa com o envelope de opacidade, deixando a cor
 *  passar intacta. É o caminho da spec pra keyframe de opacidade (provado com
 *  frame real). Vírgulas escapadas porque o valor vai dentro do filtergraph. */
function alphaEnvelopeGeq(env: Keyframe[], durSec: number): string {
  const e = envelopeExpr(env, durSec, "T");
  return `geq=lum='lum(X\\,Y)':cb='cb(X\\,Y)':cr='cr(X\\,Y)':a='255*clip(${e}\\,0\\,1)'`;
}

/**
 * O `geq` da transição WIPE (v0.4.1): uma cortina revela o clipe que entra, da
 * esquerda pra direita, ao longo de `durSec` segundos.
 *
 * A mesma técnica do envelope de opacidade — pintar o canal alfa e deixar a cor
 * intacta — só que a máscara é ESPACIAL: no instante T (tempo local do clipe,
 * antes do deslocamento pro startMs), a fronteira está em `X = W·T/d`. O pixel é
 * visível se está à esquerda dela (`gte(W*T/d, X)` → 1) e invisível à direita
 * (→ 0). Depois de `d`, tudo visível. Multiplica `alpha(X,Y)` (não SETA) pra
 * respeitar uma opacidade constante aplicada antes (colorchannelmixer).
 * Não precisa de `xfade`: a sobreposição continua sendo a transição — só o
 * jeito de entrar muda.
 */
function wipeAlphaGeq(durSec: number): string {
  const d = Math.max(0.001, durSec).toFixed(3);
  return (
    `geq=lum='lum(X\\,Y)':cb='cb(X\\,Y)':cr='cr(X\\,Y)':` +
    `a='alpha(X\\,Y)*if(lt(T\\,${d})\\,gte(W*T/${d}\\,X)\\,1)'`
  );
}

/**
 * Escapa o texto de um `drawtext`. É a fonte de bug mais clássica do ffmpeg, e
 * por isso tem teste E prova empírica (um render com `:'\%` no texto, frame
 * extraído e olhado).
 *
 * São DOIS parsers em cima do valor, e o pulo do gato é a ORDEM em que agem: o
 * filtergraph tira as aspas simples PRIMEIRO e só então o parser de opções do
 * drawtext vê o resto — então um `:` "protegido" pela aspa continua partindo a
 * opção (foi o bug real: `fontfile='C:/...'` quebrava em `/...`). A saída então
 * vai entre aspas simples (o filtergraph mantém o conteúdo literal, sem mexer nas
 * barras) E com os especiais escapados pro parser de opções que vem depois:
 *  1. contrabarra → `\\` (escape do parser de opções) — PRIMEIRO;
 *  2. `:` → `\:` (senão parte a opção do drawtext, mesmo dentro de aspas);
 *  3. `%` → `\%` (o drawtext expande `%{...}` como no strftime);
 *  4. aspa simples → `'\''` (fecha a aspa do filtergraph, escapa, reabre) — por
 *     ÚLTIMO, pra sua barra não ser dobrada pelo passo 1.
 * (Comprovado com ffmpeg real: só assim o frame com `:'\%` sai com o texto.)
 */
export function drawtextEscape(s: string): string {
  // Comprovado com ffmpeg real (frame extraído e olhado), para o valor indo
  // ENTRE aspas simples no filtergraph. A aspa é a parte chata: como não cabe
  // aspa dentro de aspas simples, a gente FECHA a aspa, emite a aspa escapada
  // pros dois níveis (`\\\'` → `\'` → `'`), e REABRE. Ordem: barra, dois-pontos,
  // porcento e — por último — a aspa (pra suas barras não serem tocadas).
  return s
    .replace(/\\/g, "\\\\") // `\` literal → chega como `\`
    .replace(/:/g, "\\:") // sobrevive ao parser de opções do drawtext
    .replace(/%/g, "\\\\%") // chega ao drawtext como `\%` (escape de porcento)
    .replace(/'/g, "'\\\\\\''"); // fecha aspa, `\'` escapado, reabre
}

/** Envolve um caminho de fonte pro `fontfile` do drawtext: barra normal (o `\`
 *  do Windows é escape) e — o gotcha do Windows — o `:` do `C:` escapado como
 *  `\:` DENTRO das aspas, pra o parser de opções do drawtext não partir ali. */
function fontfileArg(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\\\\\''");
  return `'${p}'`;
}

/** Geometria/fps de saída: a do PRIMEIRO clipe de mídia da trilha base é "o
 *  vídeo" pro usuário; o fps é o MAIOR (baixar joga quadro fora de vez). Um
 *  preset com resolução/fps cravados VENCE — é o que faz "vertical 9:16" sair
 *  1080×1920 mesmo com fonte 640×480 (o clipe entra com barra, sem esticar). */
function targetFormat(
  tl: Timeline,
  sources: MediaSources,
  preset?: ExportPreset,
): { w: number; h: number; fps: number } {
  let w = 0;
  let h = 0;
  let fps = 0;
  for (const track of tl.tracks) {
    for (const c of track.clips) {
      if (c.path === undefined) continue;
      const s = sources[c.path];
      if (!s) continue;
      if (w === 0 && track.kind === "video") {
        w = s.width;
        h = s.height;
      }
      fps = Math.max(fps, s.fps || 0);
    }
  }
  const outW = preset && preset.width > 0 ? preset.width : w || 1920;
  const outH = preset && preset.height > 0 ? preset.height : h || 1080;
  const outFps = preset && preset.fps > 0 ? preset.fps : fps || 30;
  return { w: outW, h: outH, fps: outFps };
}

/** A janela `[start,end)` do clipe na timeline, em segundos com 3 casas. */
function span(c: Clip): { s: string; e: string } {
  return { s: secs(c.startMs), e: secs(c.startMs + c.durationMs) };
}

/** Y do título conforme a âncora (expressão do drawtext, com `text_h`/`h`). */
function titleY(anchor: string): string {
  if (anchor === "top") return "(h*0.08)";
  if (anchor === "center") return "(h-text_h)/2";
  return "(h-text_h-h*0.08)"; // bottom
}

/**
 * Sobreposição (crossfade) entre dois clipes vizinhos de uma trilha, em ms.
 * Igual ao `overlapWithNext` do `timeline.ts`, mas local pro compilador não
 * depender do módulo de UI. Zero quando não se cruzam.
 */
function overlapMs(a: Clip, b: Clip): number {
  const ov = a.startMs + a.durationMs - b.startMs;
  return Math.max(0, Math.min(ov, a.durationMs, b.durationMs));
}

/**
 * O compilador. Devolve o vetor COMPLETO de args do ffmpeg (entradas +
 * `-filter_complex` + mapeamento + codec). Função pura — é o coração testável.
 *
 * Precondição: a timeline tem ao menos um clipe. O caminho degenerado (1 trilha,
 * em fila, sem nada da v0.2) NÃO passa por aqui — vai pelo `-c copy` do
 * `planExport`, que continua instantâneo (ver `degenerateClips`).
 */
export function filterComplexArgs(
  tl: Timeline,
  sources: MediaSources,
  out: string,
  opts: CompileOptions = {},
): string[] {
  const xp = opts.exportPreset;
  const crf = opts.crf ?? xp?.crf ?? 20;
  const preset = opts.preset ?? xp?.x264preset ?? "veryfast";
  const vcodec = xp?.vcodec ?? "libx264";
  const audioBitrate = xp?.audioBitrate ?? "192k";
  const { w, h, fps } = targetFormat(tl, sources, xp);

  // Duração do filme = a trilha mais longa (o fundo preto tem essa duração).
  let total = 0;
  for (const track of tl.tracks) {
    for (const c of track.clips) total = Math.max(total, c.startMs + c.durationMs);
  }

  const args: string[] = [];
  // Uma entrada `-i` por clipe de MÍDIA (mesmo repetindo arquivo — grafo legível
  // vale mais que grafo esperto; reabrir custa quase nada). Título não tem `-i`.
  const inputIndex = new Map<string, number>(); // clip.id -> índice de -i
  for (const track of tl.tracks) {
    for (const c of track.clips) {
      if (c.path === undefined) continue;
      inputIndex.set(c.id, args.length / 2 | 0);
      args.push("-i", c.path);
    }
  }

  const parts: string[] = [];

  /* ---------------- VÍDEO ---------------- */

  // Há vídeo pra compor? (clipe de mídia OU título numa trilha de vídeo)
  const hasVideo = tl.tracks.some(
    (t) => t.kind === "video" && t.clips.some((c) => c.path !== undefined || c.title !== undefined),
  );

  let vLabel: string | null = null;
  if (hasVideo) {
    // O fundo: preto do tamanho do filme, no fps e resolução de saída.
    parts.push(`color=c=black:s=${w}x${h}:r=${fps}:d=${secs(total)}[vbase]`);
    let acc = "[vbase]";
    let k = 0;

    for (const track of tl.tracks) {
      if (track.kind !== "video") continue;
      track.clips.forEach((c, ci) => {
        const { s, e } = span(c);

        if (c.path !== undefined) {
          // Clipe de mídia: recorta no tempo do arquivo, rebobina, aplica os
          // filtros por clipe (recorte/cor/PiP), muda a velocidade, normaliza o
          // fps, aplica alfa (opacidade/envelope + crossfade) e desloca pro
          // `startMs`; depois entra por overlay ligado só na janela do clipe.
          const idx = inputIndex.get(c.id)!;
          const info = sources[c.path];
          const sp = clipSpeed(c);
          const si = secs(c.srcIn ?? 0);
          // A janela-fonte considera a velocidade: 2× consome o dobro de fonte.
          const so = secs((c.srcIn ?? 0) + c.durationMs * sp);
          const vf = [`trim=start=${si}:end=${so}`, "setpts=PTS-STARTPTS"];

          // 1) Recorte do frame (crop) — em pixels do fonte.
          if (c.crop && !isFullCrop(c.crop)) vf.push(cropExpr(c.crop));
          // 2) Cor (eq) — brilho/contraste/saturação.
          if (c.color && !isNeutralColor(c.color)) vf.push(eqExpr(c.color));

          // 3) Geometria: PiP (escala pra uma largura menor, sem barra — o overlay
          //    posiciona) OU encaixe no quadro cheio (scale+pad). Depois de um
          //    crop as dimensões mudaram, então o encaixe também precisa rodar.
          const pip = c.transform;
          if (pip) {
            const pw = Math.max(2, Math.round((pip.scale * w) / 2) * 2); // par
            vf.push(`scale=${pw}:-2`);
          } else if (!info || info.width !== w || info.height !== h || (c.crop && !isFullCrop(c.crop))) {
            vf.push(
              `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
              `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
            );
          }
          vf.push("setsar=1");

          // 4) Velocidade: reescala o PTS (2× ⇒ metade do tempo). Antes do fps e
          //    da janela de alfa, que já contam no tempo de TIMELINE do clipe.
          if (sp !== 1) vf.push(`setpts=${(1 / sp).toFixed(6)}*PTS`);
          vf.push(`fps=${fps}`);

          // 5) Alfa: envelope de opacidade (geq) OU opacidade constante, e por
          //    cima a TRANSIÇÃO da sobreposição com o vizinho de mídia anterior.
          //    O tipo mora no clipe DE TRÁS (`transitionKind`): dissolve = fade
          //    no alfa (o de sempre); wipe = cortina por geq; slide = o x do
          //    overlay anda (abaixo). Num PiP a transição cai no dissolve —
          //    cortina/deslize de uma caixinha posicionada não têm leitura
          //    visual e o dissolve é o comportamento que sempre existiu.
          //    O geq de envelope SETA o alfa, então vem ANTES do fade/wipe (que
          //    multiplicam durante a transição). Título não faz crossfade.
          const prevClip = ci > 0 ? track.clips[ci - 1] : undefined;
          const prev = prevClip && prevClip.path !== undefined ? overlapMs(prevClip, c) : 0;
          const kind: TransitionKind =
            prev > 0 && !pip ? (prevClip?.transitionKind ?? "dissolve") : "dissolve";
          const slide = prev > 0 && !pip && kind === "slide";
          const op = c.opacity ?? 1;
          const env = c.opacityKeyframes;
          const hasEnv = !!env && env.length > 0;
          // Slide entra OPACO (o movimento é do overlay) — sem alfa não precisa
          // converter pra yuva420p à toa.
          if ((prev > 0 && !slide) || op < 1 || hasEnv) {
            vf.push("format=yuva420p");
            if (hasEnv) vf.push(alphaEnvelopeGeq(env!, c.durationMs / 1000));
            else if (op < 1) vf.push(`colorchannelmixer=aa=${op}`);
            if (prev > 0 && !slide) {
              if (kind === "wipe") vf.push(wipeAlphaGeq(prev / 1000));
              else vf.push(`fade=t=in:st=0:d=${secs(prev)}:alpha=1`);
            }
          }
          // Desloca pro lugar na timeline.
          vf.push(`setpts=PTS+${s}/TB`);

          const ox = pip ? Math.round(pip.x * w) : 0;
          const oy = pip ? Math.round(pip.y * h) : 0;
          // Slide: o x do overlay ANDA durante a sobreposição — o clipe entra da
          // esquerda (−W → 0) e crava em 0 dali em diante (o min segura). O `t`
          // aqui é o tempo da TIMELINE (o fluxo já foi deslocado pro startMs); o
          // overlay reavalia x a cada frame por padrão. Aspas simples protegem
          // as vírgulas do parser de opções, como no enable.
          const oxExpr = slide ? `'min(0,-W+(t-${s})*W/${secs(prev)})'` : String(ox);
          parts.push(`[${idx}:v]${vf.join(",")}[v${k}]`);
          parts.push(
            `${acc}[v${k}]overlay=x=${oxExpr}:y=${oy}:eof_action=pass:enable='between(t,${s},${e})'[vacc${k}]`,
          );
          acc = `[vacc${k}]`;
          k++;
        } else if (c.title) {
          // Título: drawtext direto no acumulado, ligado na janela do título.
          const font = opts.fontPath ? `fontfile=${fontfileArg(opts.fontPath)}:` : "";
          const color = c.opacity !== undefined && c.opacity < 1
            ? `${c.title.color}@${c.opacity}`
            : c.title.color;
          const dt =
            `${font}text='${drawtextEscape(c.title.text)}':` +
            `fontsize=${c.title.fontSizePx}:fontcolor=${color}:` +
            `borderw=2:bordercolor=black@0.6:` +
            `x=(w-text_w)/2:y=${titleY(c.title.anchor)}:` +
            `enable='between(t,${s},${e})'`;
          parts.push(`${acc}drawtext=${dt}[vacc${k}]`);
          acc = `[vacc${k}]`;
          k++;
        }
      });
    }
    vLabel = acc;
  }

  /* ---------------- ÁUDIO ---------------- */

  // Cada clipe de mídia COM som (e não silenciado) vira um fluxo atrasado.
  const aLabels: string[] = [];
  let ai = 0;
  for (const track of tl.tracks) {
    track.clips.forEach((c, ci) => {
      if (c.path === undefined) return;
      const info = sources[c.path];
      if (!info?.hasAudio || c.muted) return;
      const idx = inputIndex.get(c.id)!;
      const sp = clipSpeed(c);
      const si = secs(c.srcIn ?? 0);
      // Janela-fonte com velocidade: 2× consome o dobro de áudio no mesmo tempo.
      const so = secs((c.srcIn ?? 0) + c.durationMs * sp);
      const af = [
        `atrim=start=${si}:end=${so}`,
        "asetpts=PTS-STARTPTS",
        "aresample=48000",
        "aformat=sample_fmts=fltp:channel_layouts=stereo",
      ];
      // Velocidade do áudio ANTES de volume/fade/adelay: a partir daqui o tempo
      // do fluxo é o tempo de TIMELINE do clipe (0..durationMs), que é onde os
      // fades e o envelope de volume estão ancorados.
      if (sp !== 1) af.push(...atempoChain(sp));
      // Volume: envelope (expressão no tempo) OU ganho constante.
      const venv = c.volumeKeyframes;
      if (venv && venv.length > 0) {
        af.push(`volume=volume='${envelopeExpr(venv, c.durationMs / 1000, "t")}':eval=frame`);
      } else if (c.volume !== undefined && c.volume !== 1) {
        af.push(`volume=${c.volume}`);
      }
      // Fade: o maior entre o que o usuário pediu e a sobreposição (crossfade) —
      // e só com VIZINHO DE MÍDIA (título não tem áudio, não faz crossfade).
      const prevA = ci > 0 ? track.clips[ci - 1] : undefined;
      const nextA = ci < track.clips.length - 1 ? track.clips[ci + 1] : undefined;
      const inOv = prevA && prevA.path !== undefined ? overlapMs(prevA, c) : 0;
      const outOv = nextA && nextA.path !== undefined ? overlapMs(c, nextA) : 0;
      const fi = Math.max(c.fadeInMs ?? 0, inOv);
      const fo = Math.max(c.fadeOutMs ?? 0, outOv);
      if (fi > 0) af.push(`afade=t=in:st=0:d=${secs(fi)}`);
      if (fo > 0) af.push(`afade=t=out:st=${secs(c.durationMs - fo)}:d=${secs(fo)}`);
      // Atraso pro lugar na timeline (ms inteiros; `all=1` atrasa os dois canais).
      af.push(`adelay=${Math.round(c.startMs)}|${Math.round(c.startMs)}`);
      parts.push(`[${idx}:a]${af.join(",")}[a${ai}]`);
      aLabels.push(`[a${ai}]`);
      ai++;
    });
  }

  let aLabel: string | null = null;
  if (aLabels.length === 1) {
    // Um fluxo só: não precisa de amix (que baixaria/normalizaria à toa).
    parts.push(`${aLabels[0]}anull[outa]`);
    aLabel = "[outa]";
  } else if (aLabels.length > 1) {
    // `normalize=0`: soma sem dividir pela contagem. Com os fades do crossfade a
    // soma fica estável; dividir faria o volume cair quando entrasse a 2ª trilha.
    parts.push(`${aLabels.join("")}amix=inputs=${aLabels.length}:normalize=0[outa]`);
    aLabel = "[outa]";
  }

  /* ---------------- montagem final ---------------- */

  args.push("-filter_complex", parts.join(";"));
  if (vLabel) args.push("-map", vLabel);
  if (aLabel) args.push("-map", aLabel);

  if (vLabel) {
    args.push("-c:v", vcodec, "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p");
  }
  if (aLabel) args.push("-c:a", "aac", "-b:a", audioBitrate);
  args.push("-movflags", "+faststart", out);
  return args;
}

/**
 * A timeline é DEGENERADA (cabe no `-c copy` instantâneo da v0.1)? Se sim,
 * devolve os clipes em fila pro `planExport`; se não, `null` (vai de
 * `filter_complex`). É o que preserva o "instantâneo" da v0.1 e por isso é
 * testado com cuidado.
 *
 * Degenerada = **uma trilha de vídeo com conteúdo, o resto vazio**, clipes de
 * MÍDIA em FILA (sem buraco, sem sobreposição/transição), **sem** título,
 * volume≠1, mudo, fade ou opacidade. Qualquer coisa da v0.2 → `filter_complex`.
 */
export function degenerateClips(tl: Timeline): ExportClip[] | null {
  const videoTracks = tl.tracks.filter((t) => t.kind === "video");
  const withClips = tl.tracks.filter((t) => t.clips.length > 0);
  // Só UMA trilha pode ter clipes, e ela tem que ser de vídeo.
  if (withClips.length !== 1 || withClips[0].kind !== "video") return null;
  const track = withClips[0];
  if (videoTracks[0]?.id !== track.id) return null; // tem que ser a trilha base

  const clips = [...track.clips].sort((a, b) => a.startMs - b.startMs);
  let cursor = 0;
  const out: ExportClip[] = [];
  for (const c of clips) {
    if (c.path === undefined || c.srcIn === undefined) return null; // título
    if (c.title) return null;
    if (c.muted) return null;
    if (c.volume !== undefined && c.volume !== 1) return null;
    if (c.fadeInMs || c.fadeOutMs) return null;
    if (c.opacity !== undefined && c.opacity < 1) return null;
    // v0.3: qualquer filtro/velocidade/envelope tira do caminho -c copy (todos
    // exigem recodificar — não há como "copiar pacote" com pixel ou tempo mexido).
    if (c.crop && !isFullCrop(c.crop)) return null;
    if (c.transform) return null;
    if (c.color && !isNeutralColor(c.color)) return null;
    if (c.speed !== undefined && c.speed !== 1) return null;
    if (c.opacityKeyframes && c.opacityKeyframes.length > 0) return null;
    if (c.volumeKeyframes && c.volumeKeyframes.length > 0) return null;
    // Em fila, encostadinho: sem buraco e sem sobreposição (transição).
    if (c.startMs !== cursor) return null;
    cursor += c.durationMs;
    out.push({ path: c.path, srcIn: c.srcIn, srcOut: c.srcIn + c.durationMs });
  }
  return out;
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
