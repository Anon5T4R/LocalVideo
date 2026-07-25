import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { audioGainAt, audioLayersAt, hasMixAudio, usesNonDefaultAudioTrack } from "../lib/audiomix";
import {
  canDecodeLayers,
  colorToCanvasFilter,
  layersAt,
  needsComposite,
  needsVideoDecode,
  slideOffset,
  wipeRect,
  type MediaLayer,
  type TransitionState,
} from "../lib/compose";
import { canDecodeExactly, FrameSource, hasWebCodecs } from "../lib/decoder";
import { t } from "../lib/i18n";
import Icon from "./Icon";
import { containRect, movePip, pipBox, resizePip, type Corner } from "../lib/pip";
import { formatDuration, formatTimecode, gapAdvance } from "../lib/probe";
import {
  baseVideoTrack,
  clipEnd,
  clipSpeed,
  endHit,
  isImageClip,
  isMedia,
  locate,
  srcOut,
  timelineDuration,
  timeToClip,
  transitionDir,
  type Clip,
  type Transform,
  type TransitionDir,
  type TransitionKind,
} from "../lib/timeline";
import { useEditor } from "../state/editor";

/**
 * Prévia da timeline montada — **WYSIWYG na v0.3**.
 *
 * ─── Três modos, cada um honesto sobre o que é ───────────────────────────────
 *
 * 1. **PARADO, composição fiel** (o novo da v0.3): o playhead para e a gente
 *    COMPÕE a timeline no canvas — trilhas empilhadas, PiP posicionado, recorte,
 *    opacidade/keyframes, crossfade dissolvendo e o título desenhado como TEXTO
 *    no canvas (não chamando ffmpeg). O que aparece é o que exporta.
 * 2. **PARADO, base só**: sem composição (uma trilha, sem filtro) → o quadro
 *    exato da trilha base, quadro a quadro, como na v0.2.
 * 3. **TOCANDO**: quem manda é o `<video>` (traz áudio e ritmo). Compor N fontes
 *    a 30 fps ao vivo seria decodificar vários filmes ao mesmo tempo — caro e
 *    frágil. Então durante o play mostra a base e AVISA "pause pra ver a
 *    composição". Nunca finge que o play é a composição.
 *
 * **Degradar dizendo a verdade** (o selo): container que o demuxer não abre
 * (mkv/webm/avi) não dá pra compor no canvas → aviso de prévia aproximada. E o
 * ajuste de COR é aproximado no canvas (brilho aditivo vs multiplicativo) — o
 * selo diz isso também. Prometer fidelidade que não se tem é pior que não ter.
 */
export default function Preview() {
  const timeline = useEditor((s) => s.history.present);
  const media = useEditor((s) => s.media);
  const missing = useEditor((s) => s.missing);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const rate = useEditor((s) => s.rate);
  const seek = useEditor((s) => s.seek);
  const setPlaying = useEditor((s) => s.setPlaying);
  const selectedId = useEditor((s) => s.selectedId);

  /**
   * DOIS `<video>` em revezamento (v0.13) — a cura do piscar preto na emenda.
   *
   * Com UM elemento, trocar de clipe era trocar o `src`: o elemento descarta o
   * quadro, volta pra readyState 0 e mostra preto até o arquivo novo engatar —
   * o "pisca" que aparecia em toda emenda de arquivos diferentes. Agora um slot
   * é o ATIVO (visível, com som) e o outro é a RESERVA: ela pré-carrega o
   * PRÓXIMO clipe, já posicionada no `srcIn` dele, muda e pausada. Na emenda,
   * só os papéis trocam — o quadro novo já está decodificado.
   *
   * De brinde, a reserva vira o clipe de SAÍDA durante uma sobreposição: ela
   * continua tocando embaixo enquanto o ativo entra por cima com
   * opacidade/recorte/deslocamento (dissolve/wipe/slide) — a transição passa a
   * se VER durante o play, aproximada, em vez de virar corte seco.
   */
  const vid0 = useRef<HTMLVideoElement>(null);
  const vid1 = useRef<HTMLVideoElement>(null);
  const vidRefs = [vid0, vid1];
  const [activeSlot, setActiveSlot] = useState(0);
  /** O que cada slot tem preparado: qual clipe e qual arquivo. Fora do estado
   *  do React de propósito — é bookkeeping imperativo dos elementos, e mudar
   *  não deve re-renderizar nada. */
  const slotPrep = useRef<{ clipId: string | null; path: string | null }[]>([
    { clipId: null, path: null },
    { clipId: null, path: null },
  ]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** Um decodificador por arquivo: abrir custa ler o arquivo, não se faz por seta. */
  const sources = useRef<Map<string, FrameSource>>(new Map());
  /** O canvas tem um quadro pintado e válido pro playhead de agora? */
  const [painted, setPainted] = useState(false);

  const track = useMemo(() => baseVideoTrack(timeline), [timeline]);
  const total = useMemo(() => timelineDuration(timeline), [timeline]);

  // A trilha BASE ainda comanda o `<video>` (play + áudio) e o caminho simples.
  const baseHit = useMemo(
    () => timeToClip(track, playhead) ?? (playhead >= total ? endHit(track) : null),
    [track, playhead, total],
  );

  // As CAMADAS da composição no instante atual (no fim, gruda no último quadro).
  const layerT = playhead >= total ? Math.max(0, total - 1) : playhead;
  const layers = useMemo(() => layersAt(timeline, layerT), [timeline, layerT]);
  const composite = needsComposite(layers);

  // Resolução de saída = a do 1º clipe de mídia de vídeo (é "o vídeo" pro
  // usuário). O canvas é pintado nesse tamanho e o CSS encaixa na tela.
  const dims = useMemo(() => targetDims(timeline, media), [timeline, media]);

  // Dá pra compor no canvas? A regra (e por que imagem NÃO passa pelo portão do
  // WebCodecs — o bug da prévia preta) mora em `canDecodeLayers`, puro e testado.
  const mediaLayers = layers.filter((l): l is MediaLayer => l.kind === "media");
  const allDecodable = canDecodeLayers(layers, missing, canDecodeExactly);

  // `hit` do <video>: só vem de clipe de MÍDIA (o `timeToClip` filtra).
  const hitPath = baseHit?.clip.path ?? "";
  const gone = baseHit ? missing.includes(hitPath) : false;
  const fps = baseHit ? (media[hitPath]?.fps ?? 30) : 30;
  const baseExact = baseHit && !gone ? canDecodeExactly(hitPath) : false;

  // O PRÓXIMO clipe de mídia da base — quem a RESERVA pré-carrega. Dentro de um
  // clipe é o vizinho da frente (a emenda que vem aí); num buraco é o clipe do
  // outro lado do vazio (o aquecimento que a v0.8 já fazia, agora pelo slot).
  const nextClip = useMemo(() => {
    const after = baseHit ? baseHit.clipStart : playhead - 1;
    let best: Clip | null = null;
    for (const c of track?.clips ?? []) {
      if (!isMedia(c) || c.id === baseHit?.clip.id) continue;
      if (c.startMs > after && (!best || c.startMs < best.startMs)) best = c;
    }
    return best;
  }, [track, baseHit, playhead]);

  /**
   * A transição EM CURSO na entrada do clipe atual, durante o play. Espelha a
   * regra do `layersAt`/compilador: o tipo mora no clipe DE TRÁS, a geometria é
   * a sobreposição, e PiP entrando não ganha transição espacial. `null` fora da
   * janela — e é o que decide se a reserva (o clipe de saída) segue tocando.
   */
  const playXfade = useMemo(() => {
    if (!playing || rate <= 0 || !baseHit || !track) return null;
    const prev = baseHit.index > 0 ? track.clips[baseHit.index - 1] : undefined;
    if (!prev || prev.path === undefined || baseHit.clip.transform) return null;
    const ov = Math.max(
      0,
      Math.min(clipEnd(prev) - baseHit.clipStart, prev.durationMs, baseHit.clip.durationMs),
    );
    if (ov <= 0 || playhead >= baseHit.clipStart + ov) return null;
    return {
      prev,
      startMs: baseHit.clipStart,
      ov,
      kind: (prev.transitionKind ?? "dissolve") as TransitionKind,
      dir: transitionDir(prev),
    };
  }, [playing, rate, baseHit, track, playhead]);
  const inXfade = !!playXfade;
  /** Espelho em ref pro laço de rAF (que não pode remontar a cada quadro). */
  const playXfadeRef = useRef(playXfade);
  playXfadeRef.current = playXfade;
  const activeSlotRef = useRef(activeSlot);
  activeSlotRef.current = activeSlot;

  // Composição sem vídeo pra decodificar (só imagem parada e/ou título) pode
  // rodar DURANTE o play — a exceção e o porquê estão em `needsVideoDecode`.
  const stillOnly = !needsVideoDecode(layers);

  // Modo de pintura do canvas:
  //  - compor (várias camadas/filtros) se der pra decodificar tudo;
  //  - senão, o quadro exato da base (caminho da v0.2).
  // Parado, sempre; tocando, só quando não há vídeo pra decodificar (ver acima).
  const doComposite = (!playing || stillOnly) && layers.length > 0 && composite && allDecodable;

  // Fecha os decodificadores dos arquivos que saíram da timeline (memória de
  // vídeo fora do alcance do GC).
  useEffect(() => {
    const alive = new Set(
      timeline.tracks.flatMap((tk) => tk.clips.filter(isMedia).map((c) => c.path!)),
    );
    for (const [path, fs] of sources.current) {
      if (!alive.has(path)) {
        fs.dispose();
        sources.current.delete(path);
      }
    }
    // Mesma poda pro cache de imagens (o bitmap segura memória de GPU).
    for (const [path, bmp] of images.current) {
      if (!alive.has(path)) {
        bmp?.close();
        images.current.delete(path);
      }
    }
  }, [timeline]);

  useEffect(() => {
    const map = sources.current;
    const imgs = images.current;
    return () => {
      for (const fs of map.values()) fs.dispose();
      map.clear();
      for (const bmp of imgs.values()) bmp?.close();
      imgs.clear();
    };
  }, []);

  /** Pega (ou abre) o decodificador de um arquivo. */
  const sourceFor = (path: string): FrameSource => {
    let fs = sources.current.get(path);
    if (!fs) {
      fs = new FrameSource(convertFileSrc(path));
      sources.current.set(path, fs);
    }
    return fs;
  };

  /**
   * Cache de ImageBitmap por caminho (v0.14): imagem PARADA não passa pelo
   * WebCodecs (não é vídeo) — carrega uma vez via `<img>`/`createImageBitmap` e o
   * mesmo bitmap serve pra qualquer instante do clipe. O bitmap é REUTILIZADO
   * (nunca `close()` no laço de composição): o dono é este cache, que o libera
   * quando o arquivo sai da timeline. `null` guardado = falhou/carregando (a
   * composição pinta preto embaixo, sem travar).
   */
  const images = useRef<Map<string, ImageBitmap | null>>(new Map());
  const imageFor = async (path: string): Promise<ImageBitmap | null> => {
    const cache = images.current;
    if (cache.has(path)) return cache.get(path) ?? null;
    // Marca "em curso" pra dois quadros seguidos não decodificarem duas vezes.
    cache.set(path, null);
    try {
      const res = await fetch(convertFileSrc(path));
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      cache.set(path, bmp);
      return bmp;
    } catch {
      return null;
    }
  };

  /* ---------- o revezamento dos dois <video> ---------- */

  // Quem é o ATIVO e o que a RESERVA prepara — num efeito SÓ, e a ordem importa.
  // Eram dois efeitos, e a corrida mordeu (medida dirigindo a GUI): num seek pra
  // um clipe que estava na reserva, o efeito do ativo pedia a troca de papéis
  // (setActiveSlot) e o da reserva — rodando no MESMO commit, ainda com o slot
  // velho — reciclava justamente o elemento que ia ser promovido, trocando o src
  // dele; o load interrompia o play() e o catch desligava o filme. Unificado, a
  // troca de papéis RETORNA antes de mexer na reserva (o efeito re-roda já com
  // os papéis certos) e ninguém prepara por cima de ninguém.
  useEffect(() => {
    const prep = slotPrep.current;
    const cur = baseHit && !gone ? baseHit.clip : null;
    const a = activeSlot;

    if (cur && prep[a].clipId !== cur.id) {
      if (prep[1 - a].clipId === cur.id) {
        // A reserva já é este clipe (pré-carregada e posicionada): troca de
        // papéis e deixa o re-run (com os papéis novos) cuidar da reserva.
        setActiveSlot(1 - a);
        return;
      }
      // Caminho frio (seek pra longe, projeto recém-aberto): prepara o ativo
      // diretamente — é o comportamento antigo, fora do fluxo contínuo.
      const va = vidRefs[a].current;
      if (va) {
        if (prep[a].path !== cur.path) va.src = convertFileSrc(cur.path!);
        prep[a] = { clipId: cur.id, path: cur.path! };
      }
    }

    // A RESERVA pré-carrega o próximo clipe: src do arquivo, muda, pausada e já
    // posicionada no `srcIn` — pra emenda ser só a troca de papéis. Durante uma
    // sobreposição ela ainda é o clipe de SAÍDA tocando embaixo: não recicla
    // até a janela fechar (é o dep em `inXfade` que re-roda este efeito no fim).
    const s = 1 - a;
    const vs = vidRefs[s].current;
    if (!vs) return;
    const xf = playXfadeRef.current;
    if (xf && prep[s].clipId === xf.prev.id) return;
    const nc = nextClip;
    if (!nc || missing.includes(nc.path!)) return;
    if (prep[s].clipId === nc.id) return;
    if (prep[s].path !== nc.path) vs.src = convertFileSrc(nc.path!);
    prep[s] = { clipId: nc.id, path: nc.path! };
    vs.muted = true;
    vs.pause();
    const want = (nc.srcIn ?? 0) / 1000;
    const seekReady = () => {
      try {
        vs.currentTime = want;
      } catch {
        /* metadados ainda não chegaram: o crave do play corrige na troca */
      }
    };
    if (vs.readyState >= 1) seekReady();
    else vs.onloadedmetadata = () => {
      vs.onloadedmetadata = null;
      seekReady();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseHit?.clip.id, gone, activeSlot, nextClip?.id, missing, inXfade]);

  // O clipe de SAÍDA durante a sobreposição: a reserva segue tocando (muda —
  // quem tem o som é o que entra, como o <video> único já fazia) até a janela
  // fechar. Fora dela, reserva é reserva: pausada.
  useEffect(() => {
    const s = 1 - activeSlot;
    const vs = vidRefs[s].current;
    if (!vs) return;
    const xf = playXfadeRef.current;
    if (playing && rate > 0 && xf && slotPrep.current[s].clipId === xf.prev.id) {
      vs.muted = true;
      vs.playbackRate = rate;
      if (vs.paused) void vs.play().catch(() => {});
    } else {
      vs.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, rate, activeSlot, inXfade]);

  /* ---------- COMPOSIÇÃO (parado, WYSIWYG) ---------- */

  useEffect(() => {
    if (!doComposite) return;
    let dead = false;

    void (async () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = dims.w;
      canvas.height = dims.h;

      // Decodifica os quadros das camadas de mídia ANTES de pintar, pra a tela
      // não piscar meia-composição enquanto os arquivos respondem em ritmos
      // diferentes. Título não decodifica — é texto. Imagem vem do cache de
      // ImageBitmap (não do WebCodecs), e é REUTILIZÁVEL — não se fecha (`owned`
      // marca só os VideoFrame, que são por-quadro e precisam de `close()`).
      const frames = new Map<string, VideoFrame | ImageBitmap | null>();
      const owned = new Set<string>();
      for (const l of layers) {
        if (l.kind !== "media") continue;
        try {
          if (isImageClip(l.clip)) {
            frames.set(l.clip.id, await imageFor(l.clip.path!));
          } else {
            frames.set(l.clip.id, await sourceFor(l.clip.path!).frameAt(Math.round(l.srcTimeMs * 1000)));
            owned.add(l.clip.id);
          }
        } catch {
          frames.set(l.clip.id, null);
        }
        if (dead) {
          for (const [id, f] of frames) if (owned.has(id)) (f as VideoFrame | null)?.close();
          return;
        }
      }

      // Fundo preto (o buraco entre clipes é preto, como no export).
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, dims.w, dims.h);

      for (const l of layers) {
        if (l.kind === "media") {
          const frame = frames.get(l.clip.id) ?? null;
          if (frame) {
            drawMedia(ctx, frame, l.clip, dims.w, dims.h, l.alpha, l.transition);
            if (owned.has(l.clip.id)) (frame as VideoFrame).close();
          }
        } else {
          drawTitle(ctx, l.clip, dims.w, dims.h, l.alpha);
        }
      }
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      if (!dead) setPainted(true);
    })();

    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doComposite, layers, dims.w, dims.h]);

  /* ---------- o quadro exato da BASE (parado, sem composição) ---------- */

  useEffect(() => {
    // Durante o play, ou quando a composição está no comando, este caminho cala.
    if (!baseHit || gone || playing || !baseExact || doComposite) {
      if (!doComposite) setPainted(false);
      return;
    }

    let dead = false;
    const path = baseHit.clip.path!;
    const targetUs = Math.round(baseHit.srcTime * 1000);

    void (async () => {
      let frame: VideoFrame | null = null;
      try {
        frame = await sourceFor(path).frameAt(targetUs);
      } catch {
        frame = null;
      }
      if (dead || !frame) {
        frame?.close();
        if (!dead) setPainted(false);
        return;
      }
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        frame.close();
        return;
      }
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      ctx.drawImage(frame, 0, 0);
      frame.close();
      setPainted(true);
    })();

    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseHit, gone, playing, baseExact, doComposite]);

  /* ---------- o play (o <video> manda) ---------- */

  useEffect(() => {
    const v = vidRefs[activeSlot].current;
    if (!v || !baseHit || playing) return;
    // Troca de papéis a caminho: espera o commit com o slot certo (o mesmo
    // guard do efeito de play — cravar aqui mexeria no elemento errado).
    if (slotPrep.current[activeSlot].clipId !== baseHit.clip.id) return;
    const want = baseHit.srcTime / 1000;
    try {
      if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want;
    } catch {
      /* src ainda carregando: o próximo render corrige */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseHit, playing, activeSlot]);

  /* ---------- o som do <video>: MUDO e VOLUME do clipe (v0.7.1) ---------- */

  // O bug que o João sentiu e ninguém tinha visto no código: o `<video>` era
  // montado SEM `muted` e SEM `volume`. Ou seja, `clip.muted` — a propriedade
  // que o "Separar áudio" LIGA no clipe de vídeo, e que a caixinha "Silenciar"
  // do inspetor liga também — não chegava ao elemento que faz o som. Depois de
  // separar o áudio, a prévia tocava o vídeo original E os clipes de áudio
  // destacados ao mesmo tempo: o usuário ouvia tudo dobrado e concluía, com
  // razão, que "separar áudio não faz nada".
  //
  // Imperativo (não via prop `muted` no JSX) pra também levar o GANHO do clipe —
  // volume, envelope e fades — pela MESMA conta que o mixer das outras trilhas
  // usa (`audioGainAt`). Assim a base deixa de ser a única trilha cujo volume só
  // se ouvia depois de exportar. As ressalvas de honestidade (ganho > 1 não sobe
  // no HTMLMedia) são as do cabeçalho de `audiomix.ts` — as mesmas pra todos.
  //
  // v0.9: o mudo da TRILHA entra pela mesma porta, num OU com o do clipe — o som
  // da trilha base sai por este elemento, então é aqui que `Track.muted` vira
  // silêncio na prévia. Aqui e não numa segunda `useEffect` só dele: duas
  // effects escrevendo `v.muted` se sobrescreveriam na ordem em que o React
  // resolvesse rodá-las, e a que perdesse a corrida devolveria o som calada.
  // (Tentado e MEDIDO no app rodando, inclusive: uma effect nova era anulada por
  // esta a cada render. O `<video muted={...}>` declarativo também não serve —
  // o valor não chega ao elemento.)
  useEffect(() => {
    const v = vidRefs[activeSlot].current;
    if (!v) return;
    const c = baseHit?.clip;
    v.muted = !!c?.muted || !!track?.muted;
    v.volume = c ? audioGainAt(c, playhead) : 1;
    // A reserva NUNCA tem voz — som dobrado na sobreposição seria pior que o
    // silêncio do clipe de saída (o export faz o crossfade de áudio; a prévia
    // entrega o som de quem entra, como o <video> único já fazia).
    const vs = vidRefs[1 - activeSlot].current;
    if (vs) vs.muted = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseHit, playhead, track?.muted, activeSlot]);

  useEffect(() => {
    const v = vidRefs[activeSlot].current;
    if (!v) return;
    // `baseHit` é obrigatório aqui: no BURACO o `<video>` fica montado mas sem
    // clipe embaixo. Chamar `play()` num elemento sem fonte REJEITA, e o
    // `.catch` abaixo pausaria o filme no meio do vazio — quem toca o buraco é o
    // ticker de wall-clock, não o `<video>`. Sem clipe embaixo: só pausa o vídeo.
    if (playing && !gone && rate > 0 && baseHit) {
      // Se o slot ativo ainda não É o clipe atual, uma troca de papéis está a
      // caminho (o efeito de revezamento acabou de pedi-la): cravar/tocar AQUI
      // mandaria o tempo do clipe novo pro elemento velho. O commit seguinte —
      // já com os papéis certos — re-roda este efeito e aí sim engata.
      if (slotPrep.current[activeSlot].clipId !== baseHit.clip.id) return;
      // Ao ASSUMIR um clipe (troca de papel na emenda, saída do buraco), crava o
      // tempo-fonte ANTES de tocar. A reserva já vem posicionada no `srcIn`, mas
      // a folga cobre o caminho frio e o clipe aparado. Só aqui (roda na TROCA
      // de clipe, não a cada quadro), pra não brigar com o play.
      const want = baseHit.srcTime / 1000;
      try {
        if (Math.abs(v.currentTime - want) > 0.15) v.currentTime = want;
      } catch {
        /* src ainda carregando: o play engata do começo e o crave volta */
      }
      v.playbackRate = rate;
      void v.play().catch((e) => {
        // Só o veto de AUTOPLAY derruba o filme (não há o que fazer sem gesto).
        // AbortError — um load/pause atropelou este play() — é transitório: a
        // remontagem seguinte toca; derrubar aqui matava o play numa troca de
        // src legítima (medido dirigindo a GUI).
        if ((e as DOMException)?.name === "NotAllowedError") setPlaying(false);
      });
    } else {
      v.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, gone, rate, baseHit?.clip.id, activeSlot, setPlaying]);

  // Correr PELO VAZIO (pra frente): quando o playhead está num buraco não há
  // `<video>` pra tocar, então nada movia o tempo e o Espaço parecia morto. Um
  // NLE de verdade não pula nem trava o buraco — deixa o tempo andar (tela
  // preta) até cair no próximo clipe ou no fim. O relógio de parede é o motor.
  //
  // Só liga sem `baseHit` (o buraco) e com `rate > 0` (a ré tem o ticker acima);
  // assim que o tempo cruza pra dentro de um clipe, `baseHit` deixa de ser nulo,
  // este efeito se desmonta e o `<video>` assume — sem pulo nem piscada. O
  // `playhead` NÃO entra nas deps de propósito: ele é lido do `getState()` a
  // cada quadro, senão o efeito remontaria a cada tick e zeraria o `dt`.
  useEffect(() => {
    if (!playing || rate <= 0 || baseHit) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const s = useEditor.getState();
      const dur = timelineDuration(s.history.present);
      const stepd = gapAdvance(s.playhead, dt, s.rate, dur);
      s.seek(stepd.playhead);
      if (stepd.ended) {
        s.setPlaying(false);
        return; // chegou ao fim do filme: para (não reagenda)
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, baseHit]);

  // A ré, na mão: o playhead recua no relógio de parede, na velocidade pedida.
  useEffect(() => {
    if (!playing || rate >= 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const s = useEditor.getState();
      const next = s.playhead + dt * s.rate;
      if (next <= 0) {
        s.seek(0);
        s.setPlaying(false);
        return;
      }
      s.seek(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate]);

  /** Aplica (ou limpa) o estilo da transição ao vivo no instante `t`. Fora do
   *  React de propósito: rodar a 60 Hz por setState re-renderizaria a timeline
   *  inteira a cada quadro. */
  const styleXfade = (t: number) => {
    const act = vidRefs[activeSlotRef.current].current;
    if (!act) return;
    const xf = playXfadeRef.current;
    // A reserva precisa SER o clipe de saída (caminho frio não tem os quadros
    // dele): sem ela embaixo, recortar/mover o ativo revelaria o fundo preto.
    const stbIsPrev = xf && slotPrep.current[1 - activeSlotRef.current].clipId === xf.prev.id;
    if (!xf || !stbIsPrev) {
      clearEnterStyle(act);
      return;
    }
    const p = Math.max(0, Math.min(1, (t - xf.startMs) / xf.ov));
    if (p >= 1) clearEnterStyle(act);
    else applyEnterStyle(act, xf.kind, xf.dir, p);
  };

  /* ---------- o relógio do play: rAF + timeupdate lendo o <video> ativo ----- */

  /** O clipe sob o playhead, fora do ciclo do React (o passo do relógio lê
   *  daqui pra não remontar nada a cada quadro). */
  const baseHitRef = useRef(baseHit);
  baseHitRef.current = baseHit;
  const lastSeekRef = useRef(0);

  /**
   * UM passo do relógio de reprodução: lê o `currentTime` do vídeo ativo, move
   * o playhead, detecta a emenda e anima a transição ao vivo. Tudo deriva do
   * relógio do próprio `<video>` — nada acumula, então um passo perdido se
   * corrige sozinho no seguinte.
   *
   * Dois motores chamam isto, pelo mesmo motivo que um relógio tem corda E
   * bateria: o **rAF** dá a suavidade (o webview só dispara `timeupdate` a cada
   * ~250 ms — playhead aos trancos e a emenda detectada com um quarto de
   * segundo de atraso, o clipe de trás vazando conteúdo além do corte); o
   * **timeupdate** continua batendo quando o rAF congela — janela minimizada
   * não composita quadro e o rAF simplesmente PARA (medido dirigindo a GUI:
   * o vídeo seguia tocando e o playhead ficava plantado até o `ended` socorrer).
   */
  const stepPlayback = (force = false) => {
    const s = useEditor.getState();
    const hit = baseHitRef.current;
    const v = vidRefs[activeSlotRef.current].current;
    if (!s.playing || s.rate <= 0 || !hit || !v) return;
    // Antes dos metadados o currentTime mente (0): agir sobre ele puxaria o
    // playhead pro começo do clipe. Espera o vídeo ter quadro.
    if (v.readyState < 2 || v.paused) return;
    const clip = hit.clip;
    const srcMs = v.currentTime * 1000;
    const clipOut = srcOut(clip);
    if (srcMs >= clipOut - 1) {
      // Fim do clipe: avança pra emenda. O estado remonta com o próximo clipe
      // (e o slot já trocado pela reserva) — sem piscar.
      const dur = timelineDuration(s.history.present);
      const next = clipEnd(clip);
      if (next >= dur) {
        s.setPlaying(false);
        s.seek(dur);
      } else {
        s.seek(next);
      }
      return;
    }
    // Com velocidade, o tempo de tela anda `1/speed` do tempo-fonte.
    const t = hit.clipStart + (srcMs - (clip.srcIn ?? 0)) / clipSpeed(clip);
    const now = performance.now();
    // O seek re-renderiza timeline+prévia: ~30 Hz é liso pro olho sem virar
    // um render por quadro. O `force` é o timeupdate (que já é escasso).
    if (force || now - lastSeekRef.current > 33) {
      lastSeekRef.current = now;
      s.seek(t);
    }
    styleXfade(t);
  };
  /** Ref estável pro JSX e pros listeners (o passo lê tudo de refs/getState). */
  const stepRef = useRef(stepPlayback);
  stepRef.current = stepPlayback;

  useEffect(() => {
    if (!playing || rate <= 0 || !baseHit) return;
    let raf = 0;
    const tick = () => {
      stepRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Sem relógio não há transição em curso: limpa qualquer estilo que tenha
      // ficado (pausa no meio de um dissolve deixaria o ativo translúcido).
      for (const r of vidRefs) if (r.current) clearEnterStyle(r.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, rate, baseHit?.clip.id, activeSlot]);

  /** O rodapé conta o que a prévia É — e por que, quando é aproximada. */
  const quality = (() => {
    if (!baseHit && layers.length === 0) return "";
    // Tocando SEM compor: o `<video>` está no comando e a composição não aparece.
    // Com `doComposite` ligado durante o play (composição sem vídeo — ver
    // `stillOnly`) cai no ramo de baixo, porque aí o que se vê É a composição:
    // dizer "pause pra ver" seria mentira ao contrário.
    if (playing && !doComposite)
      return composite ? t("preview.playApprox") : baseExact ? t("preview.exact") : rough();
    // Parado (ou tocando uma composição que não precisa decodificar vídeo):
    if (composite) {
      if (!allDecodable) return t("preview.roughContainer"); // não deu pra compor
      return mediaLayers.some((l) => l.approx) ? t("preview.approx") : t("preview.wysiwyg");
    }
    return baseExact ? t("preview.exact") : rough();
  })();

  function rough() {
    return !hasWebCodecs() ? t("preview.roughNoCodecs") : t("preview.roughContainer");
  }

  // Há trilha de fundo pra mixar? Aviso honesto: a prévia AGORA toca a 2ª trilha
  // (o buraco que a v0.3 fechou), mas amplificar acima de 100% só sai no export.
  const mixNote = hasMixAudio(timeline, track?.id ?? null);
  // Aviso honesto do limite de faixa (ver `usesNonDefaultAudioTrack`): a prévia
  // toca a faixa PADRÃO de cada arquivo; só o export separa mic e sistema.
  const trackNote = usesNonDefaultAudioTrack(timeline);

  const showVideo = baseHit && !gone && !doComposite;

  // A alça de PiP DIRETA na prévia: aparece quando o clipe selecionado é mídia
  // COM transform e está ativo no instante atual (senão a caixa não teria frame
  // embaixo). Some no play — arrastar contra o ticker seria briga de relógio.
  const pipClip = (() => {
    if (playing || !selectedId) return null;
    const loc = locate(timeline, selectedId);
    const c = loc?.clip;
    if (!c || !isMedia(c) || !c.transform) return null;
    if (playhead < c.startMs || playhead >= clipEnd(c)) return null;
    return c;
  })();

  // A dica do PiP "sumido" (v0.4.1): clipe PiP selecionado mas playhead FORA da
  // janela dele. As alças somem por DESIGN (sem frame embaixo não há o que
  // posicionar — é o WYSIWYG sendo honesto), mas sumir calado deixava o usuário
  // sem entender pra onde foi a caixa. Em vez de só explicar, o botão RESOLVE:
  // leva o playhead pro clipe (e as alças voltam sozinhas).
  const pipAway = (() => {
    if (playing || !selectedId || pipClip) return null;
    const loc = locate(timeline, selectedId);
    const c = loc?.clip;
    if (!c || !isMedia(c) || !c.transform) return null;
    return c; // tem PiP, mas o playhead está fora de [startMs, clipEnd)
  })();

  // Buraco num filme que EXISTE: nem clipe embaixo, nem mídia sumida. A tela
  // fica preta (o fundo do `.stage` já é #000) e o tempo corre por cima — não é
  // "importe um vídeo" (isso é `total === 0`), é o vazio entre cortes.
  //
  // `layers.length === 0` é a parte que faltava: "sem `baseHit`" NÃO quer dizer
  // "sem imagem na tela". Imagem e título nunca entram no `timeToClip` (ele é a
  // fonte do `<video>`, que não decodifica nenhum dos dois), então uma timeline
  // feita de foto + música tinha `baseHit === null` o tempo todo e este preto
  // opaco era pintado POR CIMA do canvas composto — o segundo motivo da tela
  // preta ao montar um vídeo a partir de uma imagem. Buraco é quando não há
  // camada nenhuma pra desenhar, não quando não há vídeo.
  const inGap = !baseHit && !gone && total > 0 && layers.length === 0;
  // Dá pra tocar? Filme não-vazio e não parado num arquivo sumido. Vale pro
  // buraco também (corre pelo vazio) — por isso não exige `baseHit`.
  const canPlay = total > 0 && !gone;

  return (
    <div className="card preview-card">
      {/* O motor de áudio das trilhas de fundo — não desenha nada, só toca. */}
      <PreviewAudioMixer />
      <div className="card-head">
        <strong>{t("preview.title")}</strong>
        <span className="muted small tabnum">
          {formatTimecode(playhead, fps)} / {formatDuration(total)}
          {playing && rate !== 1 ? ` · ${rate > 0 ? "" : "◀ "}${Math.abs(rate)}×` : ""}
        </span>
      </div>

      <div className="stage" ref={stageRef}>
        {gone ? (
          <div className="stage-empty muted">{t("preview.gone")}</div>
        ) : total > 0 ? (
          <>
            {/* Os DOIS `<video>` ficam SEMPRE montados enquanto há filme (só
                escondidos): o ativo mostra o clipe de agora; a reserva pré-carrega
                o próximo (e vira o clipe de saída durante uma sobreposição — é aí
                que ela aparece, embaixo do ativo). Desmontar/remontar obrigaria a
                carregar do zero e traria de volta o piscar preto que este
                revezamento existe pra matar. O src é imperativo (efeitos de
                revezamento), não prop — mudá-lo é justamente o que se evita. */}
            {([0, 1] as const).map((slot) => (
              <video
                key={slot}
                ref={vidRefs[slot]}
                className="stage-video"
                preload="auto"
                onTimeUpdate={() => {
                  // O motor de reserva do relógio (ver `stepPlayback`): só o
                  // ativo conta — o passo já lê o elemento certo por ref.
                  if (slot === activeSlotRef.current) stepRef.current(true);
                }}
                onEnded={() => {
                  // Só o ATIVO conta (a reserva pausada não deveria terminar).
                  // O arquivo acabar É a emenda quando o clipe vai até o fim da
                  // fonte: avança — parar aqui congelaria o filme no meio.
                  if (slot !== activeSlotRef.current) return;
                  const s = useEditor.getState();
                  if (!s.playing) return;
                  const hit = timeToClip(baseVideoTrack(s.history.present), s.playhead);
                  const dur = timelineDuration(s.history.present);
                  const next = hit ? clipEnd(hit.clip) : dur;
                  if (next >= dur) {
                    s.setPlaying(false);
                    s.seek(dur);
                  } else {
                    s.seek(next);
                  }
                }}
                style={{
                  display:
                    slot === activeSlot
                      ? showVideo
                        ? "block"
                        : "none"
                      : playing && rate > 0 && inXfade
                        ? "block"
                        : "none",
                  zIndex: slot === activeSlot ? 2 : 1,
                }}
              />
            ))}
            {/* O canvas: composição (parado) ou quadro exato. Fica por cima do
                <video> pra a troca parar↔tocar não piscar preto. */}
            <canvas
              ref={canvasRef}
              className="stage-canvas"
              style={{ display: painted && (!playing || doComposite) ? "block" : "none" }}
            />
            {/* Buraco: um preto por cima do <video> escondido. Sem texto — o tempo
                correndo no cabeçalho já diz que está tocando pelo vazio. */}
            {inGap ? <div className="stage-empty" aria-label={t("preview.gap")} /> : null}
            {/* Alças de PiP: arrastar/redimensionar a caixa direto na prévia. */}
            {pipClip ? (
              <PipHandles clip={pipClip} dims={dims} media={media} stageRef={stageRef} />
            ) : null}
            {/* PiP selecionado com o playhead fora: explica E oferece o pulo. */}
            {pipAway ? (
              <div className="pip-away">
                <span>{t("pip.away")}</span>
                <button onClick={() => seek(pipAway.startMs)}>{t("pip.goto")}</button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="stage-empty muted">{t("preview.empty")}</div>
        )}
      </div>

      <div className="preview-bar">
        <button
          onClick={() => useEditor.getState().nudgeRate(-1)}
          disabled={!canPlay}
          title={t("sc.jkl")}
        >
          <Icon name="rewind" /> J
        </button>
        <button
          className="primary"
          onClick={() => setPlaying(!playing)}
          disabled={!canPlay}
          title={playing ? t("preview.pause") : t("preview.play")}
        >
          <Icon name={playing ? "pause" : "play"} /> {playing ? t("preview.pause") : t("preview.play")}
        </button>
        <button
          onClick={() => useEditor.getState().nudgeRate(1)}
          disabled={!canPlay}
          title={t("sc.jkl")}
        >
          L <Icon name="forward" />
        </button>
        <span className="muted small">{quality}</span>
        {mixNote ? (
          <span className="muted small" title={t("preview.mixHint")}>
            {t("preview.mix")}
          </span>
        ) : null}
        {trackNote ? (
          <span className="warn-note small" title={t("preview.trackLimitHint")}>
            <Icon name="warn" /> {t("preview.trackLimit")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Estado de um arrasto de PiP em curso (guarda o que não pode mudar no meio). */
type PipDrag =
  | { kind: "move"; x0: number; y0: number; base: Transform; cw: number; ch: number }
  | {
      kind: "resize";
      corner: Corner;
      base: Transform;
      rectLeft: number;
      rectTop: number;
      cw: number;
      ch: number;
    };

/** Tolerância do snap do PiP, em fração do quadro — o mesmo "quase encostou,
 *  então encostou" da régua, só que aqui contra as bordas e o centro da tela. */
const PIP_SNAP = 0.02;

/**
 * As ALÇAS do PiP direto na prévia (o item de maior valor da rodada de
 * excelência): a caixa do overlay vira arrastável e redimensionável POR CIMA do
 * WYSIWYG, e o resultado atualiza ao vivo (é o mesmo `transform` que o inspetor
 * e o compilador leem — arrastar aqui é escrever o param que o export usa).
 *
 * A matemática (mover, redimensionar por canto com aspecto travado, snap, o
 * retângulo do conteúdo no letterbox) mora em `lib/pip.ts`, pura e testada.
 * Aqui só se converte pixel↔fração e se escuta o ponteiro — e, crucial, o
 * arrasto inteiro é UM passo de undo (`beginEdit`/`endEdit` + o `doUpdateClip`
 * que coalesce dentro da sessão).
 */
function PipHandles({
  clip,
  dims,
  media,
  stageRef,
}: {
  clip: Clip;
  dims: { w: number; h: number };
  media: Record<string, { width: number; height: number }>;
  stageRef: React.RefObject<HTMLDivElement | null>;
}) {
  const doUpdateClip = useEditor((s) => s.doUpdateClip);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<PipDrag | null>(null);

  // Mede o palco e segue o resize da janela — as alças têm que colar no
  // retângulo do conteúdo, não numa medida velha de outro tamanho de janela.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageRef]);

  const outAspect = dims.w / dims.h;
  // Aspecto do frame JÁ recortado (o mesmo do `drawMedia`). Sem info da mídia,
  // cai no aspecto de saída — a caixa não distorce, só pode não bater o recorte.
  const info = clip.path ? media[clip.path] : undefined;
  const clipAspect = (() => {
    if (!info) return outAspect;
    const cw = clip.crop ? clip.crop.w * info.width : info.width;
    const ch = clip.crop ? clip.crop.h * info.height : info.height;
    return ch > 0 && cw > 0 ? cw / ch : outAspect;
  })();

  const content = containRect(stageSize.w, stageSize.h, dims.w, dims.h);
  const tr = clip.transform!;
  const box = pipBox(tr, clipAspect, outAspect);

  // O arrasto: um par estável de listeners por sessão (padrão da régua). O
  // `dragRef` sobrevive ao re-render; o efeito só liga/desliga os ouvintes.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "move") {
        const dx = (e.clientX - d.x0) / d.cw;
        const dy = (e.clientY - d.y0) / d.ch;
        const r = movePip(d.base, clipAspect, outAspect, dx, dy, PIP_SNAP);
        doUpdateClip(clip.id, { transform: r.transform });
      } else {
        const px = clamp01((e.clientX - d.rectLeft) / d.cw);
        const py = clamp01((e.clientY - d.rectTop) / d.ch);
        doUpdateClip(clip.id, {
          transform: resizePip(d.base, clipAspect, outAspect, d.corner, px, py),
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      useEditor.getState().endEdit();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const startMove = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useEditor.getState().beginEdit();
    dragRef.current = {
      kind: "move",
      x0: e.clientX,
      y0: e.clientY,
      base: tr,
      cw: content.width,
      ch: content.height,
    };
    setDragging(true);
  };
  const startResize = (corner: Corner) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = stageRef.current?.getBoundingClientRect();
    useEditor.getState().beginEdit();
    dragRef.current = {
      kind: "resize",
      corner,
      base: tr,
      rectLeft: (rect?.left ?? 0) + content.left,
      rectTop: (rect?.top ?? 0) + content.top,
      cw: content.width,
      ch: content.height,
    };
    setDragging(true);
  };

  if (content.width <= 0) return null;
  const corners: Corner[] = ["nw", "ne", "sw", "se"];
  // Guia de centro: aparece durante o arrasto quando a caixa está centrada — o
  // sinal visual de que o snap agarrou o meio da tela.
  const centeredX = Math.abs(box.x + box.w / 2 - 0.5) < 0.003;
  const centeredY = Math.abs(box.y + box.h / 2 - 0.5) < 0.003;

  return (
    <div className={`pip-overlay ${dragging ? "dragging" : ""}`}>
      <div
        className="pip-box"
        style={{
          left: content.left + box.x * content.width,
          top: content.top + box.y * content.height,
          width: box.w * content.width,
          height: box.h * content.height,
        }}
        onPointerDown={startMove}
        title={t("pip.dragHint")}
      >
        {corners.map((c) => (
          <span key={c} className={`pip-h ${c}`} onPointerDown={startResize(c)} />
        ))}
      </div>
      {dragging && centeredX ? (
        <div className="pip-guide v" style={{ left: content.left + content.width / 2 }} />
      ) : null}
      {dragging && centeredY ? (
        <div className="pip-guide h" style={{ top: content.top + content.height / 2 }} />
      ) : null}
    </div>
  );
}

/** Grampeia em 0..1 (guarda de NaN). */
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/**
 * O estilo do clipe que ENTRA durante a transição ao vivo (play). É o gêmeo em
 * CSS do que o `drawMedia` faz no canvas parado — as mesmas três geometrias,
 * derivadas das mesmas contas puras (`wipeRect`/`slideOffset`), só que em
 * porcentagem do elemento em vez de pixels do quadro:
 * - dissolve: opacidade = progresso (o alpha do `crossfadeAlpha`);
 * - wipe: `clip-path` revela a fatia já varrida (o retângulo do `wipeRect`);
 * - slide: `translate` desloca o painel inteiro (o offset do `slideOffset`).
 * Aproximado de propósito (o painel aqui é o elemento, não o quadro com barras
 * exatas do export) — e o rodapé da prévia já diz "aproximada" no play.
 */
function applyEnterStyle(
  el: HTMLVideoElement,
  kind: TransitionKind,
  dir: TransitionDir,
  p: number,
): void {
  if (kind === "wipe") {
    const r = ((1 - p) * 100).toFixed(2);
    el.style.opacity = "";
    el.style.transform = "";
    el.style.clipPath =
      dir === "lr"
        ? `inset(0 ${r}% 0 0)`
        : dir === "rl"
          ? `inset(0 0 0 ${r}%)`
          : dir === "tb"
            ? `inset(0 0 ${r}% 0)`
            : `inset(${r}% 0 0 0)`;
  } else if (kind === "slide") {
    el.style.opacity = "";
    el.style.clipPath = "";
    el.style.transform =
      dir === "lr"
        ? `translateX(${((p - 1) * 100).toFixed(2)}%)`
        : dir === "rl"
          ? `translateX(${((1 - p) * 100).toFixed(2)}%)`
          : dir === "tb"
            ? `translateY(${((p - 1) * 100).toFixed(2)}%)`
            : `translateY(${((1 - p) * 100).toFixed(2)}%)`;
  } else {
    el.style.clipPath = "";
    el.style.transform = "";
    el.style.opacity = clamp01(p).toFixed(3);
  }
}

/** Volta o elemento ao neutro (fim/cancelamento da transição ao vivo). */
function clearEnterStyle(el: HTMLVideoElement): void {
  el.style.opacity = "";
  el.style.clipPath = "";
  el.style.transform = "";
}

/**
 * O motor de áudio da 2ª trilha (música de fundo, narração) na PRÉVIA.
 *
 * Não renderiza nada: conduz um `<audio>` por clipe de áudio de mix — todas as
 * trilhas menos a base, cujo som já sai pelo `<video>` — em sincronia com o
 * playhead, pra a mixagem se OUVIR antes do export. A parte pura (quais tocam,
 * com que ganho) mora em `lib/audiomix.ts`, com as ressalvas de honestidade.
 *
 * Os `<audio>` são objetos imperativos (`new Audio()`), não JSX: som se comanda,
 * não se declara, e um por CLIPE (chaveado pelo id) sobrevive à troca de clipe
 * ativo sem recarregar o arquivo a cada quadro.
 */
function PreviewAudioMixer() {
  const timeline = useEditor((s) => s.history.present);
  const playing = useEditor((s) => s.playing);
  const rate = useEditor((s) => s.rate);
  const missing = useEditor((s) => s.missing);

  const baseId = useMemo(() => baseVideoTrack(timeline)?.id ?? null, [timeline]);
  const els = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Fecha os <audio> de clipes que saíram da timeline (ou viraram a base).
  useEffect(() => {
    const alive = new Set<string>();
    for (const tk of timeline.tracks) {
      if (tk.id === baseId) continue;
      for (const c of tk.clips) if (isMedia(c)) alive.add(c.id);
    }
    for (const [id, el] of els.current) {
      if (!alive.has(id)) {
        el.pause();
        el.src = "";
        els.current.delete(id);
      }
    }
  }, [timeline, baseId]);

  // Descarrega tudo ao desmontar (memória de áudio fora do alcance do GC).
  useEffect(() => {
    const map = els.current;
    return () => {
      for (const el of map.values()) {
        el.pause();
        el.src = "";
      }
      map.clear();
    };
  }, []);

  // O laço que casa som e playhead. Só toca no play PRA FRENTE: a ré e o scrub
  // em 2× seriam pitch picado sem valor (a base também não os mixa). Lê o estado
  // por `getState()` a cada quadro pra não remontar o efeito a cada tick — e o
  // `playhead` fica FORA das deps de propósito (senão remontaria 60×/s).
  useEffect(() => {
    if (!playing || rate <= 0) {
      for (const el of els.current.values()) el.pause();
      return;
    }
    let raf = 0;
    const tick = () => {
      const s = useEditor.getState();
      const layers = audioLayersAt(s.history.present, s.playhead, baseId).filter(
        (l) => !missing.includes(l.path),
      );
      const wanted = new Set(layers.map((l) => l.clipId));
      for (const [id, el] of els.current) if (!wanted.has(id)) el.pause();
      for (const l of layers) {
        let el = els.current.get(l.clipId);
        if (!el) {
          el = new Audio(convertFileSrc(l.path));
          el.preload = "auto";
          els.current.set(l.clipId, el);
        }
        el.volume = l.gain;
        el.playbackRate = s.rate;
        // Ressincroniza só quando DERIVA de verdade: o <audio> tem relógio
        // próprio e cravar o tempo todo quadro cortaria o som. 0,25 s de folga.
        const want = l.srcTimeMs / 1000;
        if (Number.isFinite(want) && Math.abs(el.currentTime - want) > 0.25) {
          try {
            el.currentTime = want;
          } catch {
            /* fonte ainda carregando: o próximo quadro corrige */
          }
        }
        if (el.paused) void el.play().catch(() => {});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const el of els.current.values()) el.pause();
    };
  }, [playing, rate, baseId, missing]);

  return null;
}

/** Resolução de saída da composição (a do 1º clipe de mídia de vídeo). */
function targetDims(
  tl: ReturnType<typeof useEditor.getState>["history"]["present"],
  media: Record<string, { width: number; height: number }>,
): { w: number; h: number } {
  for (const tk of tl.tracks) {
    if (tk.kind !== "video") continue;
    for (const c of tk.clips) {
      if (c.path && media[c.path]) return { w: media[c.path].width, h: media[c.path].height };
    }
  }
  return { w: 1920, h: 1080 };
}

/**
 * Desenha um clipe de mídia no canvas: recorte (crop) na fonte, PiP (posição +
 * tamanho) OU encaixe no quadro com barra, opacidade e cor (aproximada). É o
 * espelho do que o compilador faz no export.
 */
function drawMedia(
  ctx: CanvasRenderingContext2D,
  frame: VideoFrame | ImageBitmap,
  clip: Clip,
  W: number,
  H: number,
  alpha: number,
  transition?: TransitionState,
): void {
  // Dimensões da fonte: VideoFrame fala `displayWidth`; ImageBitmap fala `width`.
  const fw = (frame as VideoFrame).displayWidth ?? (frame as ImageBitmap).width;
  const fh = (frame as VideoFrame).displayHeight ?? (frame as ImageBitmap).height;
  // Recorte na fonte.
  let sx = 0;
  let sy = 0;
  let sw = fw;
  let sh = fh;
  if (clip.crop) {
    sx = clip.crop.x * fw;
    sy = clip.crop.y * fh;
    sw = Math.max(1, clip.crop.w * fw);
    sh = Math.max(1, clip.crop.h * fh);
  }

  // Orientação (v0.14): pré-orienta a região JÁ RECORTADA num canvas offscreen —
  // crop primeiro, rotação/espelho depois, a MESMA ordem do export (`orientFilters`
  // roda após o crop no compilador). Daí em diante o resto (encaixe/PiP/transição)
  // opera na fonte orientada, sem recorte extra, e a prévia bate com o arquivo.
  let blit: CanvasImageSource = frame;
  if (clip.rotate || clip.flipH) {
    const oriented = orientToCanvas(frame, sx, sy, sw, sh, clip.rotate, clip.flipH);
    blit = oriented;
    sx = 0;
    sy = 0;
    sw = oriented.width;
    sh = oriented.height;
  }
  const aspect = sw / sh;

  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.filter = clip.color ? colorToCanvasFilter(clip.color) : "none";

  if (clip.transform) {
    // PiP: largura = fração da saída; altura mantém o aspecto (como o scale=pw:-2).
    const dw = clip.transform.scale * W;
    const dh = dw / aspect;
    const dx = clip.transform.x * W;
    const dy = clip.transform.y * H;
    ctx.drawImage(blit, sx, sy, sw, sh, dx, dy, dw, dh);
  } else {
    // Quadro cheio, com barra (nunca esticado) — igual ao scale+pad do export.
    const scale = Math.min(W / sw, H / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;

    // Wipe/slide em curso (v0.4.1): a MESMA fronteira que o export desenha.
    // No ffmpeg o quadro que entra já passou pelo scale+pad — as BARRAS fazem
    // parte do painel (são preto opaco que cobre o de baixo). No canvas as
    // barras não existem (só se desenha o conteúdo), então o retângulo preto
    // entra aqui, sem o filter de cor (no export o eq roda ANTES do pad — a
    // barra não é colorida). É o que mantém a prévia honesta com o arquivo.
    if (transition?.kind === "slide") {
      // A direção vem do modelo puro (`slideOffset`), a mesma conta que o
      // compilador escreve no `overlay` — ver `lib/compose.ts`.
      const { dx: odx, dy: ody } = slideOffset(transition.dir, transition.progress, W, H);
      const f = ctx.filter;
      ctx.filter = "none";
      ctx.fillStyle = "#000";
      ctx.fillRect(odx, ody, W, H);
      ctx.filter = f;
      ctx.drawImage(blit, sx, sy, sw, sh, dx + odx, dy + ody, dw, dh);
    } else if (transition?.kind === "wipe") {
      const r = wipeRect(transition.dir, transition.progress, W, H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      const f = ctx.filter;
      ctx.filter = "none";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.filter = f;
      ctx.drawImage(blit, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.restore();
    } else {
      ctx.drawImage(blit, sx, sy, sw, sh, dx, dy, dw, dh);
    }
  }
  ctx.globalAlpha = 1;
  ctx.filter = "none";
}

/**
 * Recorta e ORIENTA uma fonte num canvas offscreen (v0.14): tira a região
 * `[sx,sy,sw,sh]`, gira `rotate` graus horário e espelha se `flipH`. Devolve um
 * canvas do tamanho JÁ ORIENTADO (90/270 trocam largura×altura). É o gêmeo em
 * canvas do `orientFilters` do compilador — a ordem crop→rotação→espelho é a
 * mesma, pra prévia e export desenharem o mesmo quadro.
 */
function orientToCanvas(
  frame: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  rotate: 90 | 180 | 270 | undefined,
  flipH: boolean | undefined,
): HTMLCanvasElement {
  const odd = rotate === 90 || rotate === 270;
  const ow = odd ? sh : sw;
  const oh = odd ? sw : sh;
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(ow));
  cv.height = Math.max(1, Math.round(oh));
  const c = cv.getContext("2d")!;
  c.translate(cv.width / 2, cv.height / 2);
  // O canvas COMPÕE a matriz (T·S·R): o `drawImage` sofre a transformação da
  // DIREITA pra esquerda — ou seja, `rotate` age no ponto ANTES do `scale`. Pra
  // reproduzir a cadeia do export (`transpose` e DEPOIS `hflip` = espelho após a
  // rotação), o `scale` vem no código ANTES do `rotate`.
  if (flipH) c.scale(-1, 1);
  if (rotate) c.rotate((rotate * Math.PI) / 180);
  // Depois de girar, o sistema de eixos é o da fonte (sw×sh): centraliza nela.
  c.drawImage(frame, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
  return cv;
}

/** Desenha um título como TEXTO no canvas (não chama ffmpeg na prévia). Espelha
 *  o `drawtext`: centralizado em x, âncora em cima/meio/embaixo, borda preta. */
function drawTitle(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  W: number,
  H: number,
  alpha: number,
): void {
  const tp = clip.title!;
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.filter = "none";
  ctx.font = `${tp.fontSizePx}px sans-serif`;
  ctx.textAlign = "center";
  const x = W / 2;
  let y: number;
  if (tp.anchor === "top") {
    ctx.textBaseline = "top";
    y = H * 0.08;
  } else if (tp.anchor === "center") {
    ctx.textBaseline = "middle";
    y = H / 2;
  } else {
    ctx.textBaseline = "alphabetic";
    y = H - H * 0.08;
  }
  // Fundo (v0.14): a caixa atrás do texto, espelhando a `box` do drawtext
  // (`boxborderw=12`). Desenhada ANTES do texto. A altura vem das métricas da
  // fonte (ascent+descent), a largura do texto medido — mais 12px de margem em
  // volta, o mesmo do export.
  if (tp.bg) {
    const pad = 12;
    const m = ctx.measureText(tp.text);
    const asc = m.actualBoundingBoxAscent || tp.fontSizePx * 0.8;
    const desc = m.actualBoundingBoxDescent || tp.fontSizePx * 0.2;
    const bw = m.width + pad * 2;
    const bh = asc + desc + pad * 2;
    let by: number;
    if (tp.anchor === "top") by = y - pad;
    else if (tp.anchor === "center") by = y - asc - pad;
    else by = y - asc - pad;
    ctx.fillStyle = tp.bg;
    ctx.fillRect(x - bw / 2, by, bw, bh);
  }
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.strokeText(tp.text, x, y);
  ctx.fillStyle = tp.color;
  ctx.fillText(tp.text, x, y);
  ctx.globalAlpha = 1;
}
