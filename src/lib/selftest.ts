import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { FrameSource, hasWebCodecs } from "./decoder";

/**
 * Autoteste do WebCodecs — **só em dev** (`import.meta.env.DEV`).
 *
 * Por que isto existe: a prévia quadro a quadro depende de um `VideoDecoder` que
 * só existe em contexto trustworthy, e **testar fora do app dá resposta errada**.
 * Um HTML solto aberto do disco é `origin: null` → o `VideoDecoder` some e você
 * conclui, errado, que a máquina não suporta. É o falso negativo que a spec
 * avisa, e que já enganou o spike da fase 0.
 *
 * Então a única prova que vale é DENTRO do app servido. Este módulo roda no
 * arranque do `tauri dev`, decodifica um quadro de verdade e manda o veredito
 * pro `stderr` do processo (via `dev_log`) — que é onde dá pra ler sem precisar
 * dirigir a janela com a mão.
 *
 * **Ele já se pagou:** foi assim que se descobriu que a aceleração por hardware
 * pendura o `flush()` pra sempre neste WebView2 (ver `decoder.ts`). Nenhum teste
 * de unidade acharia isso, e `isConfigSupported()` jurava que estava tudo bem.
 *
 * Como usar — **qualquer caminho serve, em qualquer unidade**, que é justamente
 * o que este teste passou a provar (ver abaixo):
 *
 *     VITE_SELFTEST='D:\videos\a.mp4' npm run tauri dev
 *
 * Opcionalmente, um segundo caminho que o teste **NÃO** vai liberar, pra provar
 * que o escopo continua fechado pra quem o usuário não escolheu:
 *
 *     VITE_SELFTEST_DENIED='D:\videos\b.mp4'
 *
 * Sem a variável, não faz nada. E no build de produção o `import.meta.env.DEV` é
 * `false`, então o bundler apaga tudo isto — não vai um byte pro instalador.
 *
 * ─── O que o `DENIED` prova ─────────────────────────────────────────────────
 *
 * O `assetProtocol.scope` nasce VAZIO e quem entra nele é o `allow_media`, no
 * gesto do usuário (ver `src-tauri/src/media.rs`). Um teste que só mostrasse o
 * arquivo liberado abrindo não distinguiria "o escopo de runtime funciona" de
 * "alguém abriu o disco inteiro". Os dois arquivos juntos fecham a conta: o
 * liberado decodifica, o não-liberado toma 403.
 */
export async function runWebCodecsSelfTest(path: string, deniedPath?: string): Promise<void> {
  const log = (msg: string) => void invoke("dev_log", { msg }).catch(() => {});

  await log(`[selftest] origem=${window.location.origin} secureContext=${window.isSecureContext}`);

  // ── Controle: um arquivo que ninguém liberou tem que tomar 403. ────────────
  // Num arquivo DIFERENTE do que vai ser decodificado, de propósito: dois GET
  // seguidos na MESMA url do `asset.localhost` se atropelam (o segundo falha ou
  // pendura), e era esse tiro no pé que fazia este autoteste acusar erro que ele
  // mesmo causava.
  if (deniedPath) {
    try {
      const res = await fetch(convertFileSrc(deniedPath));
      await log(
        res.ok
          ? `[selftest] ESCOPO ABERTO DEMAIS: ${deniedPath} respondeu ${res.status} sem ninguém ter liberado.`
          : `[selftest] escopo fechado, ok: ${deniedPath} → ${res.status} (esperado 403).`,
      );
    } catch (e) {
      await log(`[selftest] escopo fechado, ok: ${deniedPath} → ${String(e)}`);
    }
  }

  // ── O gesto do usuário, imitado: escolher o arquivo é o que o libera. ──────
  // É exatamente o que o `importPaths` faz antes de pôr o clipe na tela.
  try {
    await invoke("allow_media", { paths: [path] });
    await log(`[selftest] allow_media ok para ${path}`);
  } catch (e) {
    await log(`[selftest] allow_media FALHOU: ${String(e)}`);
  }

  // O sinal que vale é `VideoDecoder`. `VideoFrame`/`EncodedVideoChunk` NÃO são
  // SecureContext-gated: eles ficam lá mesmo quando a decodificação não existe,
  // e é justamente esse "meio-suporte" aparente que engana.
  await log(
    `[selftest] VideoDecoder=${typeof window.VideoDecoder} ` +
      `VideoFrame=${typeof window.VideoFrame} ` +
      `EncodedVideoChunk=${typeof window.EncodedVideoChunk}`,
  );

  if (!hasWebCodecs()) {
    await log("[selftest] REPROVADO: VideoDecoder não existe neste contexto.");
    return;
  }

  try {
    const url = convertFileSrc(path);
    await log(`[selftest] url=${url}`);

    // **UM fetch só, igualzinho à produção.** Sondar a URL antes, "só pra ver",
    // foi o que fez este autoteste acusar um `Failed to fetch` que ele mesmo
    // causou: dois GET seguidos no `asset.localhost` da mesma URL — o segundo
    // falha ou pendura. O `FrameSource` busca sozinho; deixa ele buscar.
    const fs = new FrameSource(url);
    // 2,5 s: de propósito NÃO é quadro-chave (com GOP de 1 s eles caem nos
    // segundos redondos). Assim o teste prova o caminho inteiro — decodificar do
    // quadro-chave anterior ATÉ o quadro pedido —, e não só "abriu o arquivo".
    //
    // A corrida contra o relógio existe pra o autoteste **nunca** ficar mudo:
    // "travou" é um resultado, e um resultado que precisa aparecer.
    const frame = await Promise.race([
      fs.frameAt(2_500_000),
      new Promise<null>((_r, rej) => setTimeout(() => rej(new Error("timeout 15s")), 15000)),
    ]);
    if (!frame) {
      await log("[selftest] REPROVADO: o decodificador não devolveu quadro.");
      return;
    }
    await log(
      `[selftest] APROVADO: quadro decodificado ${frame.displayWidth}x${frame.displayHeight} ` +
        `ts=${frame.timestamp}µs formato=${frame.format}`,
    );
    frame.close();
    fs.dispose();
  } catch (e) {
    await log(`[selftest] REPROVADO: ${String(e)}`);
  }
}
