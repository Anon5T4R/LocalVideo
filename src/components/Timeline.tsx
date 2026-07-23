import { useEffect, useMemo, useRef, useState } from "react";

import { t } from "../lib/i18n";
import Icon from "./Icon";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { audioTrackAt, formatDelta, formatDuration, nearestThumb, trackDisplayName } from "../lib/probe";
import type { MediaInfo } from "../lib/probe";
import { peakColumns, waveformPath } from "../lib/peaks";
import { anchoredScrollLeft, snapMove, snapValue } from "../lib/snap";
import {
  canRemoveTrack,
  clipDuration,
  clipEnd,
  clipSpeed,
  DEFAULT_TRANSITION_MS,
  isMedia,
  isTitle,
  locate,
  overlapWithNext,
  timelineDuration,
  type Clip,
  type Timeline,
  type Track,
  type TrackKind,
} from "../lib/timeline";
import { baseName, peakKey, useEditor } from "../state/editor";
import { setLaneResolver } from "../state/lanedrop";
import { useUi } from "../state/ui";

/** Passos de régua "redondos" (ms) — a escala tem que ser de relógio. */
const TICK_STEPS = [200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 300_000, 600_000];
const MIN_TICK_PX = 64;
const THUMB_W = 90;

/**
 * Altura da lane POR TIPO (v0.9.2). Antes eram 60px pra todo mundo — o que
 * sobrava numa trilha de áudio (uma barra com um rótulo) faltava numa de vídeo
 * (miniatura espremida), e oito trilhas comiam a tela à toa. É a proporção que
 * todo NLE usa: vídeo mais alto porque tem imagem pra mostrar; áudio mais baixo
 * porque a onda se lê bem em pouca altura.
 *
 * Constante daqui E do cabeçalho da trilha ao mesmo tempo: as duas colunas
 * (`tl-heads` e as lanes) têm que bater linha a linha, senão o V2 aponta pra
 * trilha do A1.
 */
const LANE_H_VIDEO = 64;
/** 52 e não 44: medido no app, um clipe de áudio de 44px dá 31px de corpo, e o
 *  rótulo (19px) comia DOIS TERÇOS da onda — sobrava 10px de forma de onda
 *  legível, que é menos do que a fatia inteira se propôs a entregar. Com 52 o
 *  rótulo vira um chip curto no topo (ver `.tl-lane.audio .tl-clip-label`) e a
 *  onda fica com o corpo inteiro. */
const LANE_H_AUDIO = 52;
function laneHeight(kind: TrackKind): number {
  return kind === "audio" ? LANE_H_AUDIO : LANE_H_VIDEO;
}

/** Largura de uma coluna da forma de onda, em px de tela. 2px é o ponto em que a
 *  onda ainda tem desenho (não vira um bloco) sem pedir mil colunas por clipe. */
const WAVE_COL_PX = 2;
/** Altura do espaço-tempo do `<svg>` da onda. Número ARBITRÁRIO de propósito: o
 *  `preserveAspectRatio="none"` estica o desenho pra caixa real do clipe, então
 *  esta é a resolução vertical do caminho, não pixels de tela. */
const WAVE_H = 100;
/** Largura da coluna de cabeçalhos (V1/A1 + botões). Constante daqui e do CSS ao
 *  mesmo tempo: é ela que o `fit()` desconta da largura útil da régua. */
const HEAD_W = 116;
/** Passo do pan por roda, em px de tela. Um "clique" de roda entrega ~100 no
 *  Chromium; usar o `deltaY` cru faria a régua saltar meia tela por gesto. */
const WHEEL_PAN_PX = 60;
/** Quanto um clique de roda amplia. 1.15 dá ~5 cliques por dobrada — fino o
 *  bastante pra mirar num corte sem virar uma eternidade pra sair do zoom. */
const WHEEL_ZOOM = 1.15;

/** O que está sendo arrastado agora. */
type Drag =
  | { kind: "move"; id: string; x0: number; start0: number; dur0: number; trackId: string }
  | { kind: "in" | "out"; id: string; x0: number; start0: number; end0: number }
  | { kind: "trans"; id: string; x0: number; trans0: number };

/** Distância (px) em que uma borda "quase encostou" já encaixa numa marca. */
const SNAP_PX = 8;

/**
 * As marcas de encaixe: as bordas de todos os OUTROS clipes (começo e fim, em
 * todas as trilhas), o playhead e o zero. Pura pra a régua não precisar recalcular
 * na mão a cada quadro do arrasto.
 */
function snapTargets(tl: Timeline, exceptId: string, playhead: number): number[] {
  const out: number[] = [0, playhead];
  for (const tk of tl.tracks) {
    for (const c of tk.clips) {
      if (c.id === exceptId) continue;
      out.push(c.startMs, clipEnd(c));
    }
  }
  return out;
}

/**
 * A timeline multitrilha da v0.2: trilhas empilhadas, clipes posicionados no
 * tempo (`startMs`), arrastar pra mover no tempo E entre trilhas, alças pra
 * aparar, e a alça de transição (crossfade) na emenda.
 *
 * Toda a matemática de EDIÇÃO mora em `lib/timeline.ts` (puro e testado); aqui
 * só se converte pixel↔ms e se escuta o ponteiro. O arrasto usa `pointer` (não
 * o DnD nativo) porque precisa de ms contínuo — o DnD só avisa em passos
 * grosseiros e não sabe dizer em qual trilha o dedo está.
 */
export default function Timeline() {
  const timeline = useEditor((s) => s.history.present);
  const thumbs = useEditor((s) => s.thumbs);
  const peaks = useEditor((s) => s.peaks);
  const missing = useEditor((s) => s.missing);
  const media = useEditor((s) => s.media);
  const playhead = useEditor((s) => s.playhead);
  const selectedId = useEditor((s) => s.selectedId);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const seek = useEditor((s) => s.seek);
  const select = useEditor((s) => s.select);
  const setZoom = useEditor((s) => s.setZoom);
  const doTrimEdge = useEditor((s) => s.doTrimEdge);
  const doMoveClip = useEditor((s) => s.doMoveClip);
  const doSetTransition = useEditor((s) => s.doSetTransition);
  const doSetTransitionRipple = useEditor((s) => s.doSetTransitionRipple);
  const doSplit = useEditor((s) => s.doSplit);
  const doRemove = useEditor((s) => s.doRemove);
  const doAddTrack = useEditor((s) => s.doAddTrack);
  const rippleMode = useEditor((s) => s.rippleMode);
  const setRippleMode = useEditor((s) => s.setRippleMode);
  const snapMode = useEditor((s) => s.snapMode);
  const setSnapMode = useEditor((s) => s.setSnapMode);
  const doSetTrackMuted = useEditor((s) => s.doSetTrackMuted);
  const doRemoveTrack = useEditor((s) => s.doRemoveTrack);
  const doMoveTrack = useEditor((s) => s.doMoveTrack);
  const setConfirmOpen = useUi((s) => s.setConfirmOpen);
  const setHelpOpen = useUi((s) => s.setHelpOpen);
  const doDetachAudio = useEditor((s) => s.doDetachAudio);
  const doDuplicate = useEditor((s) => s.doDuplicate);
  const doUpdateClip = useEditor((s) => s.doUpdateClip);
  const doAddTitle = useEditor((s) => s.doAddTitle);
  const importEmbeddedSubtitles = useEditor((s) => s.importEmbeddedSubtitles);
  const [menu, setMenu] = useState<{ x: number; y: number; clip: Clip } | null>(null);
  /** A trilha que o usuário mandou remover e ainda tem clipes dentro: a
   *  confirmação. `null` = não há nada pra confirmar. */
  const [killTrack, setKillTrack] = useState<{ id: string; label: string; n: number } | null>(null);

  /** O elemento que ROLA (os dois eixos): cabeçalhos grudam nele pela esquerda e
   *  as trilhas rolam na vertical dentro dele. */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** O espaço-tempo da régua. Todo px↔ms sai do rect DELE — e não do scroller —
   *  porque só ele começa exatamente no ms 0: medir pelo scroller obrigaria a
   *  descontar `HEAD_W` e o `scrollLeft` na mão em cada gesto, e foi assim que a
   *  coluna de cabeçalhos deslocaria o clique da régua em 116px. */
  const innerRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Arrastando a régua (scrub)? Estado próprio: o scrub não mexe na timeline, só
   *  no playhead, então não abre sessão de undo como os arrastos de clipe. */
  const [scrubbing, setScrubbing] = useState(false);
  /** A marca (ms) onde o arrasto encaixou agora — pra desenhar a guia. `null` =
   *  não encaixou (ou não há arrasto). */
  const [snapLine, setSnapLine] = useState<number | null>(null);
  /**
   * O NÚMERO do arrasto em curso: onde a borda está agora e quanto ela andou.
   *
   * Fecha metade da pendência A5 do ESTADO. Até aqui os arrastos eram cegos: dá
   * pra sentir que o clipe andou, mas não pra saber SE andou meio segundo ou dois
   * — e a régua só tem marca a cada N segundos. Quem apara pra casar com uma
   * batida ou com o fim de uma frase precisa do número, não da sensação.
   *
   * Vive em estado do componente (e não no store) de propósito: é rastro do
   * gesto, some ao soltar e não é estado do projeto — no store entraria no
   * caminho de re-render de todo mundo por nada.
   */
  const [dragTip, setDragTip] = useState<{ x: number; y: number; at: string; delta: string } | null>(
    null,
  );

  const total = useMemo(() => timelineDuration(timeline), [timeline]);
  const msToPx = (ms: number) => (ms / 1000) * pxPerSec;
  const pxToMs = (px: number) => (px / pxPerSec) * 1000;
  const width = Math.max(msToPx(total), 1);

  const clipCount = timeline.tracks.reduce((n, tk) => n + tk.clips.length, 0);

  // Cabeçalho de cada trilha: "V1/V2…" pra vídeo, "A1/A2…" pra áudio, numerado
  // POR TIPO (é como todo NLE nomeia — "trilha 3" não diz nada; "A2" diz).
  const laneLabels = useMemo(() => {
    const m = new Map<string, { label: string; hint: string }>();
    let v = 0;
    let a = 0;
    for (const tk of timeline.tracks) {
      if (tk.kind === "video") m.set(tk.id, { label: `V${++v}`, hint: t("tl.laneVideo", { n: v }) });
      else m.set(tk.id, { label: `A${++a}`, hint: t("tl.laneAudio", { n: a }) });
    }
    return m;
  }, [timeline]);

  /** Nome da FAIXA-FONTE de um clipe de áudio destacado ("Microfone", "Áudio do
   *  sistema") — só quando o arquivo tem 2+ faixas (com uma, o nome não
   *  distingue nada). É o que deixa dois clipes idênticos na régua dizerem qual
   *  é qual sem abrir o inspetor. */
  const sourceTrackName = (track: Track, c: Clip): string | undefined => {
    if (track.kind !== "audio" || !c.path) return undefined;
    const tracks = media[c.path]?.audioTracks;
    if (!tracks || tracks.length < 2) return undefined;
    // ORDINAL, não índice de stream — ver `audioTrackAt`. Procurar por
    // `a.index === idx` fazia o clipe da 1ª faixa ficar sem etiqueta nenhuma
    // (não existe stream 0 de áudio num arquivo com vídeo) e o da 2ª exibir o
    // nome da 1ª: dois clipes que o olho não distinguia.
    const idx = c.audioStreamIndex ?? 0;
    const info = audioTrackAt(tracks, idx);
    return info ? (trackDisplayName(info) ?? t("track.n", { n: idx + 1 })) : undefined;
  };

  /* ---- o arrasto (mover / aparar / transição), tudo por pointer ---- */
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = pxToMs(e.clientX - d.x0);
      // Encaixe: tolerância em ms derivada do zoom (mesmo "tamanho de dedo" em
      // qualquer escala). O Alt INVERTE o interruptor (v0.9) em vez de só
      // desligar: com o snap ligado ele é a saída de emergência de sempre; com o
      // snap desligado no botão, ele vira o encaixe pontual — o mesmo dedo serve
      // pra exceção nos dois modos, que é o que um NLE faz.
      const on = useEditor.getState().snapMode !== e.altKey;
      const tol = on ? pxToMs(SNAP_PX) : 0;
      const s = useEditor.getState();
      const targets = snapTargets(s.history.present, d.id, s.playhead);

      // O número que a etiqueta mostra, por tipo de arrasto: ONDE a borda está
      // agora e QUANTO ela andou desde o começo do gesto. O `y` vem do ponteiro
      // pra a etiqueta seguir o dedo entre trilhas; o `x` vem do valor JÁ
      // encaixado (senão ela mentiria por alguns pixels sempre que o snap
      // grudasse numa marca).
      const tip = (valueMs: number, deltaMs: number) => {
        const el = innerRef.current;
        if (!el) return;
        // Coordenadas do `tl-inner` (é lá que a etiqueta é desenhada, junto com
        // o playhead e a snapline): x sai do ms, y sai do ponteiro.
        setDragTip({
          x: msToPx(valueMs),
          y: e.clientY - el.getBoundingClientRect().top,
          at: formatDuration(valueMs),
          delta: formatDelta(deltaMs),
        });
      };

      if (d.kind === "move") {
        // Trilha de destino = a lane sob o dedo (senão, a de origem).
        let toTrack = d.trackId;
        for (const [id, el] of laneRefs.current) {
          const r = el.getBoundingClientRect();
          if (e.clientY >= r.top && e.clientY <= r.bottom) toTrack = id;
        }
        const raw = Math.max(0, d.start0 + delta);
        const snap = snapMove(raw, d.dur0, targets, tol);
        setSnapLine(snap.guide);
        doMoveClip(d.id, toTrack, snap.startMs);
        tip(snap.startMs, snap.startMs - d.start0);
      } else if (d.kind === "in") {
        const snap = snapValue(d.start0 + delta, targets, tol);
        setSnapLine(snap.target);
        doTrimEdge(d.id, "in", snap.value);
        tip(snap.value, snap.value - d.start0);
      } else if (d.kind === "out") {
        const snap = snapValue(d.end0 + delta, targets, tol);
        setSnapLine(snap.target);
        doTrimEdge(d.id, "out", snap.value);
        tip(snap.value, snap.value - d.end0);
      } else if (d.kind === "trans") {
        // Arrastar a alça pra ESQUERDA aumenta a sobreposição (transição).
        doSetTransition(d.id, d.trans0 - delta);
        // Aqui o número é a DURAÇÃO da transição (não uma posição na régua): é
        // o que a pessoa está ajustando, e é ele que o inspetor mostra.
        const loc = locate(useEditor.getState().history.present, d.id);
        const ov = loc ? overlapWithNext(loc.track, loc.ci) : 0;
        tip(loc ? clipEnd(loc.clip) - ov : 0, ov - d.trans0);
      }
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      setSnapLine(null);
      setDragTip(null);
      useEditor.getState().endEdit();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, pxPerSec]);

  const beginDrag = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    select(d.id);
    dragRef.current = d;
    setDragging(true);
    useEditor.getState().beginEdit();
  };

  /** Onde no TEMPO está este ponteiro. Mede pelo `tl-inner` (ver `innerRef`). */
  const msFromEvent = (clientX: number): number | null => {
    const el = innerRef.current;
    if (!el) return null;
    return pxToMs(clientX - el.getBoundingClientRect().left);
  };

  const seekFromEvent = (e: { clientX: number }) => {
    const ms = msFromEvent(e.clientX);
    if (ms !== null) seek(ms);
  };

  /**
   * Scrub: arrastar a régua e o filme SEGUIR o dedo.
   *
   * Até a v0.8 a régua era um `onClick` — dava pra pular pra um instante, mas não
   * pra varrer o filme procurando o quadro certo, que é o gesto mais básico de um
   * NLE. Agora o pointerdown já busca (o clique continua funcionando igual) e o
   * movimento continua buscando até soltar.
   *
   * Não abre `beginEdit`: mover o playhead não é edição e não pode entrar no
   * histórico — um scrub de dois segundos viraria 120 passos de Ctrl+Z.
   */
  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: PointerEvent) => seekFromEvent(e);
    const onUp = () => setScrubbing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, pxPerSec]);

  const beginScrub = (e: React.PointerEvent) => {
    // Parar antes de varrer: o ticker do play e o dedo brigariam pelo playhead e
    // o quadro ficaria pulando entre os dois donos.
    useEditor.getState().setPlaying(false);
    seekFromEvent(e);
    setScrubbing(true);
    // Capturar é BÔNUS (quem escuta de verdade é a window, acima): serve pra o
    // gesto sobreviver a sair da janela. E é try/catch obrigatoriamente — com um
    // pointer que já não está ativo, `setPointerCapture` lança `NotFoundError` e
    // mata o handler CALADO, levando junto o `setScrubbing` que vem depois. É o
    // gotcha que já mordeu cinco apps da suíte.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer não-ativo: o gesto segue pelos listeners da window */
    }
  };

  /**
   * A régua RESPONDE ao painel de mídia: "se eu soltar neste ponto da tela, em
   * que trilha e em que instante cai?" (ver `state/lanedrop.ts` pro porquê de a
   * ponte ser um registro de módulo e não estado no store).
   *
   * Quem converte pixel↔ms é aqui e continua sendo aqui: `pxPerSec`, o rect do
   * `tl-inner` (que começa exatamente no ms 0 — o mesmo cuidado do `innerRef`) e
   * as lanes vivem neste componente. O painel só pergunta e desenha a marca.
   *
   * Sem deps além do zoom: o resolver lê tudo do DOM na hora da pergunta, então
   * não envelhece com scroll nem com trilha nova.
   */
  useEffect(() => {
    setLaneResolver((clientX, clientY) => {
      const inner = innerRef.current;
      if (!inner) return null;
      for (const [trackId, el] of laneRefs.current) {
        const r = el.getBoundingClientRect();
        if (clientY < r.top || clientY > r.bottom) continue;
        // Fora do espaço-tempo da régua (à esquerda do ms 0, ou depois do fim
        // desenhado) não é alvo: soltar sobre a coluna de cabeçalhos criaria um
        // clipe no ms 0 sem o usuário ter mirado nisso.
        if (clientX < r.left || clientX > r.right) continue;
        const startMs = Math.max(0, pxToMs(clientX - inner.getBoundingClientRect().left));
        return {
          trackId,
          startMs,
          left: clientX,
          top: r.top,
          height: r.height,
        };
      }
      return null;
    });
    return () => setLaneResolver(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pxPerSec]);

  /**
   * A roda sobre a timeline, com os três papéis que todo NLE dá a ela:
   * **Ctrl+roda = zoom ANCORADO no cursor** (o ponto sob o mouse não sai do
   * lugar — ver `anchoredScrollLeft`), **roda = pan horizontal** (é a régua: o
   * eixo natural dela é o tempo, não a pilha de trilhas) e **Shift+roda =
   * vertical**, pra alcançar as trilhas de baixo quando passam da altura.
   *
   * Listener NATIVO com `{ passive: false }` e não `onWheel`: o React registra o
   * `wheel` como passivo, e num listener passivo o `preventDefault` é ignorado
   * (com aviso no console) — a página rolaria junto com o zoom.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const inner = innerRef.current;
        if (!inner) return;
        const from = useEditor.getState().pxPerSec;
        const anchorPx = e.clientX - inner.getBoundingClientRect().left;
        // `setZoom` grampeia em 4..400; ler DE VOLTA o valor aplicado faz a
        // âncora acertar mesmo no limite do zoom (senão, no fim de curso o
        // conteúdo escorregava um pouco a cada clique de roda que não ampliou).
        setZoom(e.deltaY < 0 ? from * WHEEL_ZOOM : from / WHEEL_ZOOM);
        const to = useEditor.getState().pxPerSec;
        el.scrollLeft = anchoredScrollLeft(el.scrollLeft, anchorPx, from, to);
        return;
      }
      if (e.shiftKey) return; // vertical: é o comportamento nativo do scroller
      e.preventDefault();
      el.scrollLeft += Math.sign(e.deltaY || e.deltaX) * WHEEL_PAN_PX;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  // O fantasma do ripple na borda IN (v0.4.1). No ripple, aparar pela esquerda
  // NÃO move a borda: o start fica colado, a alça apara a CABEÇA e a fila puxa —
  // correto, mas menos óbvio que a borda OUT (nada parece "andar" com o mouse).
  // Este fantasma dá corpo ao gesto: uma hachura do TAMANHO do trecho que já
  // saiu, encostada na borda fixa, com o delta em cima. A semântica não muda —
  // é só o gesto ganhando um rastro visível. Derivado no render (não em estado
  // próprio) porque cada movimento do arrasto já re-renderiza via store.
  const rippleGhost = (() => {
    const d = dragRef.current;
    if (!dragging || !d || d.kind !== "in" || !rippleMode) return null;
    const loc = locate(timeline, d.id);
    if (!loc) return null;
    const trimmedMs = d.end0 - d.start0 - clipDuration(loc.clip);
    if (trimmedMs <= 0) return null; // devolvendo cabeça: o conteúdo voltando já é o feedback
    return { trackId: loc.track.id, startMs: loc.clip.startMs, trimmedMs };
  })();

  const step = TICK_STEPS.find((s) => msToPx(s) >= MIN_TICK_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let ms = 0; ms <= total; ms += step) ticks.push(ms);

  const fit = () => {
    const el = scrollRef.current;
    if (!el || total <= 0) return;
    // `HEAD_W` sai da conta: a coluna de cabeçalhos ocupa o scroller mas NÃO é
    // espaço de régua. Sem descontá-la, "caber" deixava o fim do filme escondido
    // atrás dos exatos 116px da coluna.
    setZoom(((el.clientWidth - HEAD_W - 24) / total) * 1000);
  };

  /** Fecha a confirmação de remover trilha — e SOLTA a trava de teclas junto.
   *  Os dois sempre andam em par: esquecer o `setConfirmOpen(false)` deixaria o
   *  editor mudo pro teclado pelo resto da sessão. */
  const closeKill = () => {
    setKillTrack(null);
    setConfirmOpen(false);
  };

  return (
    <div className="tl">
      <div className="tl-head">
        <strong>{t("tl.title")}</strong>
        {/* (A contagem de clipes saiu daqui na v0.9.2: ela agora vive na
            statusbar única lá embaixo, junto do playhead — ver `tl-status`.) */}
        <span className="toolbar-fill" />
        <button onClick={doSplit} title={`${t("tl.split")} (S)`} disabled={clipCount === 0}>
          <Icon name="split" /> {t("tl.split")}
        </button>
        <button
          onClick={() => doDuplicate()}
          title={`${t("tl.ctxDuplicate")} (Ctrl+D)`}
          disabled={!selectedId}
        >
          <Icon name="plus" /> {t("tl.duplicate")}
        </button>
        <button
          onClick={() => doRemove()}
          title={`${rippleMode ? t("tl.removeRipple") : t("tl.remove")} (Del)`}
          disabled={!selectedId}
        >
          <Icon name="trash" /> {t("tl.remove")}
        </button>
        <span className="tl-sep" aria-hidden />
        <button
          className={rippleMode ? "on" : ""}
          onClick={() => setRippleMode(!rippleMode)}
          aria-pressed={rippleMode}
          title={rippleMode ? t("tl.rippleOn") : t("tl.rippleOff")}
        >
          <Icon name="ripple" /> {t("tl.ripple")}
        </button>
        <button
          className={snapMode ? "on" : ""}
          onClick={() => setSnapMode(!snapMode)}
          aria-pressed={snapMode}
          title={snapMode ? t("tl.snapOn") : t("tl.snapOff")}
        >
          <Icon name="fit" /> {t("tl.snap")}
        </button>
        <span className="tl-sep" aria-hidden />
        <button onClick={() => doAddTrack("video")} title={t("tl.addVideo")}>
          <Icon name="addVideo" /> {t("tl.addVideo")}
        </button>
        <button onClick={() => doAddTrack("audio")} title={t("tl.addAudio")}>
          <Icon name="addAudio" /> {t("tl.addAudio")}
        </button>
        <span className="tl-zoom">
          <button onClick={() => setZoom(pxPerSec / 1.5)} title={t("tl.zoomOut")}>
            −
          </button>
          <button onClick={fit} title={t("tl.zoomFit")} disabled={total <= 0}>
            <Icon name="fit" />
          </button>
          <button onClick={() => setZoom(pxPerSec * 1.5)} title={t("tl.zoomIn")}>
            +
          </button>
        </span>
      </div>

      {/* O scroller dos DOIS eixos. A coluna de cabeçalhos gruda nele pela
          esquerda (`position: sticky`) e as trilhas passam por baixo; na vertical
          o `max-height` do CSS segura a pilha, e é isso que faz 8 trilhas
          pararem de empurrar a prévia pra fora da tela. Playhead e guia de
          encaixe continuam absolutos dentro do `tl-inner` — o espaço-tempo deles
          não mudou de dono, só ganhou uma coluna de vizinha. */}
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-grid">
          <div className="tl-heads" style={{ width: HEAD_W }}>
            {/* Alinha a coluna com a régua: mesma altura, mesma borda de baixo. */}
            <div className="tl-heads-gap" />
            {timeline.tracks.map((track) => (
              <TrackHead
                key={track.id}
                track={track}
                label={laneLabels.get(track.id)?.label ?? ""}
                hint={laneLabels.get(track.id)?.hint ?? ""}
                canRemove={canRemoveTrack(timeline, track.id)}
                onToggleMute={() => doSetTrackMuted(track.id, !track.muted)}
                onMove={(dir) => doMoveTrack(track.id, dir)}
                onRemove={() => {
                  // Vazia sai na hora (não há o que perder); com clipes dentro,
                  // pergunta — e é a única confirmação da timeline, porque é a
                  // única ação que leva embora trabalho que não está selecionado
                  // (o Del some com UM clipe, que o olho vê; isto some com dez).
                  if (track.clips.length === 0) {
                    doRemoveTrack(track.id);
                    return;
                  }
                  setConfirmOpen(true);
                  setKillTrack({
                    id: track.id,
                    label: laneLabels.get(track.id)?.label ?? "",
                    n: track.clips.length,
                  });
                }}
              />
            ))}
          </div>

          <div className="tl-inner" ref={innerRef} style={{ width }}>
            {/* régua — clicar busca, ARRASTAR varre (v0.9) */}
            <div className="tl-ruler" onPointerDown={beginScrub}>
              {ticks.map((ms) => (
                <span key={ms} className="tl-tick" style={{ left: msToPx(ms) }}>
                  <i />
                  <em>{formatDuration(ms)}</em>
                </span>
              ))}
            </div>

            {/* trilhas empilhadas */}
            {timeline.tracks.map((track) => (
              <div
                key={track.id}
                className={`tl-lane ${track.kind}${track.muted ? " muted-track" : ""}`}
                style={{ height: laneHeight(track.kind) }}
                ref={(el) => {
                  if (el) laneRefs.current.set(track.id, el);
                  else laneRefs.current.delete(track.id);
                }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) seekFromEvent(e);
                }}
              >
                {track.clips.map((c, i) => (
                  <ClipView
                    key={c.id}
                    clip={c}
                    track={track}
                    index={i}
                    msToPx={msToPx}
                    selected={selectedId === c.id}
                    gone={c.path ? missing.includes(c.path) : false}
                    strip={c.path ? thumbs[c.path] : undefined}
                    hasInfo={c.path ? !!media[c.path] : false}
                    // A onda só é buscada pra clipe em trilha de ÁUDIO: numa de
                    // vídeo quem conta a história é a miniatura, e desenhar as
                    // duas coisas na mesma caixa não deixa ler nenhuma.
                    wave={
                      track.kind === "audio" && c.path
                        ? peaks[peakKey(c.path, c.audioStreamIndex ?? 0)]
                        : undefined
                    }
                    fileDurationMs={c.path ? (media[c.path]?.durationMs ?? 0) : 0}
                    srcTrackName={sourceTrackName(track, c)}
                    onSelect={() => select(c.id)}
                    onBodyDown={(e) =>
                      beginDrag(e, {
                        kind: "move",
                        id: c.id,
                        x0: e.clientX,
                        start0: c.startMs,
                        dur0: clipDuration(c),
                        trackId: track.id,
                      })
                    }
                    onInDown={(e) =>
                      beginDrag(e, { kind: "in", id: c.id, x0: e.clientX, start0: c.startMs, end0: clipEnd(c) })
                    }
                    onOutDown={(e) =>
                      beginDrag(e, { kind: "out", id: c.id, x0: e.clientX, start0: c.startMs, end0: clipEnd(c) })
                    }
                    onTransDown={(e) =>
                      beginDrag(e, { kind: "trans", id: c.id, x0: e.clientX, trans0: overlapWithNext(track, i) })
                    }
                    onContext={(e) => {
                      e.preventDefault();
                      select(c.id);
                      setMenu({ x: e.clientX, y: e.clientY, clip: c });
                    }}
                  />
                ))}
                {/* o trecho que SAIU pela cabeça durante o ripple na borda IN */}
                {rippleGhost && rippleGhost.trackId === track.id ? (
                  <div
                    className="tl-ripple-ghost"
                    style={{
                      left: msToPx(rippleGhost.startMs) - msToPx(rippleGhost.trimmedMs),
                      width: msToPx(rippleGhost.trimmedMs),
                    }}
                  >
                    <em>−{formatDuration(rippleGhost.trimmedMs)}</em>
                  </div>
                ) : null}
              </div>
            ))}

            {/* guia de encaixe: uma linha fina na marca onde a borda grudou */}
            {dragging && snapLine !== null ? (
              <div className="tl-snapline" style={{ left: msToPx(snapLine) }} />
            ) : null}

            {/* A etiqueta numérica do arrasto (v0.9.2): onde a borda está e
                quanto ela andou. Fica presa ao ponto do gesto, não a um canto
                da tela — o olho já está ali. */}
            {dragging && dragTip ? (
              <div className="dragtip tl-dragtip" style={{ left: dragTip.x, top: dragTip.y }}>
                <b className="tabnum">{dragTip.at}</b>
                <em className="tabnum">{dragTip.delta}</em>
              </div>
            ) : null}

            {/* playhead por cima de tudo */}
            <div className="tl-playhead" style={{ left: msToPx(playhead) }}>
              <i />
            </div>
          </div>
        </div>
      </div>

      {/* A STATUSBAR única (v0.9.2). Antes eram duas linhas permanentes de dica
          — o rodapé da timeline E o `dragHint` do inspetor —, cada uma repetindo
          uma parte da verdade e nenhuma dizendo onde o playhead está. Agora é
          uma faixa só: dica contextual à esquerda, números à direita. */}
      <div className="tl-status muted small">
        <span className="tl-status-hint">
          {dragTip
            ? `${dragTip.at} · ${dragTip.delta}`
            : selectedId
              ? t("clip.dragHint", { at: formatDuration(playhead) })
              : clipCount > 0
                ? t("tl.dragHint2")
                : t("empty.tip")}
        </span>
        <span className="toolbar-fill" />
        <span className="tabnum">{t("st.playhead", { at: formatDuration(playhead) })}</span>
        <span aria-hidden>·</span>
        <span className="tabnum">{t("tl.stats", { n: clipCount, dur: formatDuration(total) })}</span>
        <button className="mini" onClick={() => setHelpOpen(true)} title={t("help.title")}>
          ?
        </button>
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={clipMenuItems(
            menu.clip,
            media,
            {
              split: doSplit,
              detach: () => doDetachAudio(menu.clip.id),
              duplicate: () => doDuplicate(menu.clip.id),
              toggleMute: () => doUpdateClip(menu.clip.id, { muted: !menu.clip.muted }),
              addTitle: doAddTitle,
              remove: () => doRemove(menu.clip.id),
              importSub: (ordinal) => {
                if (menu.clip.path) void importEmbeddedSubtitles(menu.clip.path, ordinal);
              },
              addTransition: () => doSetTransitionRipple(menu.clip.id, DEFAULT_TRANSITION_MS),
              removeTransition: () => doSetTransitionRipple(menu.clip.id, 0),
            },
            rippleMode,
            transitionCtx(timeline, menu.clip.id),
          )}
        />
      ) : null}

      {killTrack ? (
        <div className="modal-backdrop" onClick={closeKill}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t("trk.removeTitle", { label: killTrack.label })}</h2>
            <p className="muted">{t("trk.removeBody", { n: killTrack.n })}</p>
            <div className="modal-actions">
              <button onClick={closeKill}>{t("dlg.cancel")}</button>
              <button
                className="danger"
                onClick={() => {
                  doRemoveTrack(killTrack.id);
                  closeKill();
                }}
              >
                {t("trk.remove")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * O cabeçalho de UMA trilha: rótulo (V1/A1), mudo, subir/descer, remover.
 *
 * Até a v0.8 o rótulo era um badge flutuando DENTRO da lane — sumia debaixo do
 * primeiro clipe que passasse por ali, e não havia onde pendurar controle
 * nenhum. Numa coluna fixa ele para de brigar com as miniaturas e vira UI de
 * verdade: cada trilha ganha os botões que um NLE tem.
 */
function TrackHead(p: {
  track: Track;
  label: string;
  hint: string;
  canRemove: boolean;
  onToggleMute: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const muted = !!p.track.muted;
  return (
    <div
      className={`tl-head-row ${p.track.kind}${muted ? " muted-track" : ""}`}
      style={{ height: laneHeight(p.track.kind) }}
    >
      <span className="tl-head-name" title={p.hint}>
        <Icon name={p.track.kind === "video" ? "addVideo" : "addAudio"} />
        <em>{p.label}</em>
      </span>
      <span className="tl-head-btns">
        <button
          className={muted ? "on" : ""}
          aria-pressed={muted}
          onClick={p.onToggleMute}
          title={muted ? t("trk.unmute") : t("trk.mute")}
        >
          {muted ? "🔇" : "🔈"}
        </button>
        <button onClick={() => p.onMove(-1)} title={t("trk.up")}>
          ↑
        </button>
        <button onClick={() => p.onMove(1)} title={t("trk.down")}>
          ↓
        </button>
        <button
          className="danger"
          onClick={p.onRemove}
          disabled={!p.canRemove}
          // Desabilitado só acontece na ÚLTIMA trilha de vídeo: o título diz por
          // quê, senão o botão cinza parece o app quebrado (ver `canRemoveTrack`).
          title={p.canRemove ? t("trk.remove") : t("trk.lastVideo")}
        >
          ×
        </button>
      </span>
    </div>
  );
}

/** A emenda deste clipe com o próximo, do jeito que o menu precisa saber:
 *  dá pra criar transição ali? já existe uma? Puro — a regra é a MESMA do
 *  inspetor (próximo clipe de mídia, sem PiP, em trilha de vídeo). */
function transitionCtx(tl: Timeline, id: string): { canTransition: boolean; hasTransition: boolean } {
  const loc = locate(tl, id);
  const next = loc ? loc.track.clips[loc.ci + 1] : undefined;
  const can =
    !!loc &&
    loc.track.kind === "video" &&
    isMedia(loc.clip) &&
    !!next &&
    next.path !== undefined &&
    !next.transform;
  return {
    canTransition: can,
    hasTransition: can && overlapWithNext(loc!.track, loc!.ci) > 0,
  };
}

/** As ações do menu de contexto de um clipe. Função pura (sem hook, sem store):
 *  recebe o clipe e a mídia, decide o que faz sentido, e devolve os itens. Fora
 *  do componente pra ser testável e pra não remontar a cada render. */
function clipMenuItems(
  clip: Clip,
  media: Record<string, Pick<MediaInfo, "audioTracks"> & Partial<Pick<MediaInfo, "subtitleTracks">>>,
  act: {
    split: () => void;
    detach: () => void;
    duplicate: () => void;
    toggleMute: () => void;
    addTitle: () => void;
    remove: () => void;
    importSub: (ordinal: number) => void;
    addTransition: () => void;
    removeTransition: () => void;
  },
  /** O modo Ripple está ligado? Só muda o RÓTULO do remover — a ação já
   *  consulta o modo no store. Um "Remover" que fecha o buraco sem avisar é
   *  surpresa; dizer "e fechar o buraco" é o mesmo clique, honesto. */
  rippleMode = false,
  trans: { canTransition: boolean; hasTransition: boolean } = {
    canTransition: false,
    hasTransition: false,
  },
): MenuItem[] {
  const info = clip.path ? media[clip.path] : undefined;
  const nAudio = info?.audioTracks.length ?? 0;
  // Separar áudio só faz sentido em clipe de mídia COM som e ainda não mudo.
  const canDetach = isMedia(clip) && nAudio > 0 && !clip.muted;
  const detachLabel =
    nAudio > 1 ? t("tl.ctxDetachN", { n: String(nAudio) }) : t("tl.ctxDetach");
  // Legendas EMBUTIDAS no arquivo deste clipe: um item por faixa, com o nome que
  // veio no container (title/language; sem nome, "Faixa N"). Só existe quando o
  // probe viu faixa — vídeo sem legenda não ganha item cinza à toa.
  const subs = (isMedia(clip) ? (info?.subtitleTracks ?? []) : []).map((s, i) => ({
    label: t("sub.ctxEmbedded", {
      name: trackDisplayName(s) ?? t("track.n", { n: s.index + 1 }),
    }),
    onClick: () => act.importSub(s.index),
    divider: i === 0,
  }));
  return [
    { label: t("tl.split"), hint: "S", onClick: act.split, disabled: !isMedia(clip) },
    { label: t("tl.ctxDuplicate"), hint: "Ctrl+D", onClick: act.duplicate },
    {
      label: clip.muted ? t("tl.ctxUnmute") : t("tl.ctxMute"),
      onClick: act.toggleMute,
      disabled: !isMedia(clip) || nAudio === 0,
      divider: true,
    },
    { label: detachLabel, onClick: act.detach, disabled: !canDetach },
    ...subs,
    // A transição no lugar onde a mão já está: o botão direito na emenda. Com
    // sobreposição vira "remover"; sem próximo clipe fica cinza — desabilitado
    // ENSINA que a ação existe (mesmo critério do separar áudio acima).
    {
      label: trans.hasTransition ? t("tl.ctxTransRemove") : t("tl.ctxTransAdd"),
      onClick: trans.hasTransition ? act.removeTransition : act.addTransition,
      disabled: !trans.canTransition,
      divider: true,
    },
    { label: t("title.add"), hint: "T", onClick: act.addTitle, divider: true },
    {
      label: rippleMode ? t("tl.removeRipple") : t("tl.remove"),
      hint: "Del",
      onClick: act.remove,
      danger: true,
      divider: true,
    },
  ];
}

interface ClipViewProps {
  clip: Clip;
  track: Track;
  index: number;
  msToPx: (ms: number) => number;
  selected: boolean;
  gone: boolean;
  strip: { timesMs: number[]; urls: string[] } | undefined;
  hasInfo: boolean;
  /** Picos (0..1) do ARQUIVO inteiro da faixa deste clipe; `undefined` enquanto
   *  a extração não voltou (ou em trilha de vídeo, que não desenha onda). */
  wave?: number[];
  /** Duração do arquivo-fonte — é a escala em que os picos foram amostrados. */
  fileDurationMs: number;
  /** Nome da faixa-fonte (clipe de áudio destacado de arquivo multi-faixa). */
  srcTrackName?: string;
  onSelect: () => void;
  onBodyDown: (e: React.PointerEvent) => void;
  onInDown: (e: React.PointerEvent) => void;
  onOutDown: (e: React.PointerEvent) => void;
  onTransDown: (e: React.PointerEvent) => void;
  onContext: (e: React.MouseEvent) => void;
}

/** Um clipe na régua: mídia (miniaturas) ou título (chip de texto). */
function ClipView(p: ClipViewProps) {
  const { clip: c, track, index, msToPx } = p;
  const w = msToPx(clipDuration(c));
  const left = msToPx(c.startMs);
  const overlap = overlapWithNext(track, index);

  const cls = [
    "tl-clip",
    isTitle(c) ? "title" : "media",
    p.selected ? "sel" : "",
    p.gone ? "gone" : "",
    c.muted ? "muted-clip" : "",
  ]
    .join(" ")
    .trim();

  const slots = Math.max(1, Math.round(w / THUMB_W));

  /**
   * A forma de onda deste clipe (v0.9.2).
   *
   * Derivada NO RENDER, não guardada em estado: o desenho depende de três coisas
   * que mudam o tempo todo (a largura, que é o zoom; o `srcIn`, que é o aparar;
   * e a velocidade) e um estado espelhando isso ficaria velho no meio de um
   * arrasto — a onda "andaria atrasada" em relação à borda que o dedo puxa. As
   * duas funções são puras e testadas (`lib/peaks.ts`), então recalcular é
   * barato: um `max` por coluna sobre um vetor de 2000.
   *
   * `srcSpan` = duração × velocidade é a MESMA invariante do compilador
   * (`lib/args.ts`): um clipe a 2× consome o dobro de fonte, e a onda espreme
   * junto — senão a régua mostraria uma onda que não é a que sai no arquivo.
   */
  const wavePath = (() => {
    if (!p.wave || p.wave.length === 0 || p.fileDurationMs <= 0 || w < 4) return "";
    const cols = Math.max(4, Math.round(w / WAVE_COL_PX));
    const srcSpan = clipDuration(c) * clipSpeed(c);
    return waveformPath(peakColumns(p.wave, p.fileDurationMs, c.srcIn ?? 0, srcSpan, cols), w, WAVE_H);
  })();

  return (
    <div
      className={cls}
      style={{ width: w, left }}
      onClick={(e) => {
        e.stopPropagation();
        p.onSelect();
      }}
      onPointerDown={p.onBodyDown}
      onContextMenu={p.onContext}
      title={
        isTitle(c)
          ? c.title!.text
          : p.srcTrackName
            ? `${baseName(c.path ?? "")} · ${p.srcTrackName}`
            : baseName(c.path ?? "")
      }
    >
      {isMedia(c) && track.kind === "audio" ? (
        // Clipe de áudio: a ONDA, não as miniaturas do vídeo de onde ele saiu.
        // (Até a v0.9 a lane de áudio desenhava as mesmas thumbs da de vídeo —
        // imagem que não diz nada sobre o som e ainda cobria o rótulo da faixa.)
        // O `viewBox` é o w×h do próprio clipe e o `preserveAspectRatio` fica
        // desligado: assim a onda estica com a caixa sem redesenhar o caminho
        // quando só a ALTURA muda.
        <div className="tl-wave" aria-hidden>
          {wavePath ? (
            <svg viewBox={`0 0 ${w} ${WAVE_H}`} preserveAspectRatio="none">
              <path d={wavePath} />
            </svg>
          ) : null}
        </div>
      ) : isMedia(c) ? (
        <div className="tl-thumbs" aria-hidden>
          {p.strip && p.strip.urls.length > 0
            ? Array.from({ length: slots }, (_, k) => {
                const at = (c.srcIn ?? 0) + (clipDuration(c) * (2 * k + 1)) / (2 * slots);
                const idx = nearestThumb(p.strip!.timesMs, at);
                return <img key={k} src={p.strip!.urls[idx]} alt="" draggable={false} />;
              })
            : null}
        </div>
      ) : (
        <div className="tl-title-chip" aria-hidden>
          <span>{c.title!.text || "—"}</span>
        </div>
      )}

      <div className="tl-clip-label">
        <span>{isTitle(c) ? `“${c.title!.text}”` : baseName(c.path ?? "")}</span>
        {p.srcTrackName ? <span className="tl-srctrack">{p.srcTrackName}</span> : null}
        <span className="muted">{formatDuration(clipDuration(c))}</span>
        {/* O aviso de "ainda não extraí" é o da MÍDIA que esta lane desenha:
            miniatura em trilha de vídeo, forma de onda em trilha de áudio.
            Dizer "sem miniaturas" num clipe de áudio (o que acontecia antes)
            aponta pra uma coisa que aquela lane nem mostra. */}
        {isMedia(c) && p.hasInfo && track.kind === "audio" && !p.wave ? (
          <span className="muted">· {t("tl.noWave")}</span>
        ) : isMedia(c) && p.hasInfo && track.kind !== "audio" && !p.strip ? (
          <span className="muted">· {t("tl.noThumbs")}</span>
        ) : null}
      </div>

      {/* alça de aparar início */}
      <span className="tl-handle in" onPointerDown={p.onInDown} onClick={(e) => e.stopPropagation()} title={t("clip.trimIn")} />
      {/* alça de aparar fim */}
      <span className="tl-handle out" onPointerDown={p.onOutDown} onClick={(e) => e.stopPropagation()} title={t("clip.trimOut")} />
      {/* alça de transição (crossfade com o próximo) — só quando há um próximo */}
      {index < track.clips.length - 1 ? (
        <span
          className={`tl-handle trans ${overlap > 0 ? "on" : ""}`}
          onPointerDown={p.onTransDown}
          onClick={(e) => e.stopPropagation()}
          title={t("clip.transition")}
        >
          {overlap > 0 ? <em>{formatDuration(overlap)}</em> : null}
        </span>
      ) : null}
    </div>
  );
}
