import { beforeEach, describe, expect, it } from "vitest";
import {
  addSubtitles,
  detachAudio,
  __resetIds,
  addTitle,
  addTrack,
  appendMedia,
  baseVideoTrack,
  canRedo,
  canRemoveTrack,
  canUndo,
  clipEnd,
  moveTrack,
  removeTrack,
  setTrackMuted,
  clipCount,
  clipSpeed,
  defaultTitle,
  endHit,
  initHistory,
  locate,
  moveClip,
  newTimeline,
  overlapWithNext,
  pushHistory,
  redo,
  removeClip,
  removeClipRipple,
  duplicateClip,
  splitTargetId,
  replacePresent,
  setClipEdge,
  setClipSpeed,
  setTransition,
  setTransitionRipple,
  splitAt,
  srcOut,
  srcWindowMs,
  timelineDuration,
  timeToClip,
  insertMediaAt,
  mediaUsageCount,
  trackEnd,
  undo,
  updateClip,
  type Clip,
  type Timeline,
  type Track,
} from "../timeline";

const media = (id: string, startMs: number, durationMs: number, srcIn = 0, path = "a.mp4"): Clip => ({
  id,
  startMs,
  durationMs,
  path,
  srcIn,
});

const vtrack = (clips: Clip[], id = "v1"): Track => ({ id, kind: "video", clips });
const atrack = (clips: Clip[], id = "a1"): Track => ({ id, kind: "audio", clips });
const tl = (tracks: Track[]): Timeline => ({ version: 2, tracks });

/** Trilha base: a=[0,1000), b=[1000,3000), c=[3000,6000) — 6 s em fila. */
const base = (): Timeline =>
  tl([
    vtrack([media("a", 0, 1000), media("b", 1000, 2000, 5000, "b.mp4"), media("c", 3000, 3000, 0, "c.mp4")]),
    atrack([]),
  ]);

beforeEach(() => __resetIds());

describe("leitura", () => {
  it("duração e fim do clipe/trilha/timeline", () => {
    const t = base();
    expect(srcOut(t.tracks[0].clips[1])).toBe(7000);
    expect(clipEnd(t.tracks[0].clips[2])).toBe(6000);
    expect(trackEnd(t.tracks[0])).toBe(6000);
    expect(timelineDuration(t)).toBe(6000);
    expect(clipCount(t)).toBe(3);
  });

  it("a trilha mais longa manda na duração (overlay pode ser mais curto)", () => {
    const t = tl([vtrack([media("a", 0, 4000)]), vtrack([media("b", 0, 2000)], "v2")]);
    expect(timelineDuration(t)).toBe(4000);
  });

  it("timeToClip traduz tempo de timeline pra tempo-fonte", () => {
    const t = base();
    const track = baseVideoTrack(t)!;
    expect(timeToClip(track, 500)).toMatchObject({ index: 0, srcTime: 500, clipStart: 0 });
    // 1500 = 500ms depois do srcIn (5000) do 2º clipe.
    expect(timeToClip(track, 1500)).toMatchObject({ index: 1, srcTime: 5500, clipStart: 1000 });
  });

  it("num buraco (gap) não há clipe tocando", () => {
    const t = tl([vtrack([media("a", 0, 1000), media("b", 3000, 1000)]), atrack([])]);
    expect(timeToClip(t.tracks[0], 2000)).toBeNull();
  });

  it("na sobreposição quem toca é o de cima (o último)", () => {
    const t = tl([vtrack([media("a", 0, 3000), media("b", 2000, 3000, 0, "b.mp4")])]);
    // Em 2500 ambos existem; ganha o b (de cima).
    expect(timeToClip(t.tracks[0], 2500)?.clip.id).toBe("b");
  });

  it("endHit dá o último quadro; vazio é null", () => {
    expect(endHit(baseVideoTrack(base())!)).toMatchObject({ index: 2, srcTime: 3000 });
    expect(endHit(vtrack([]))).toBeNull();
  });

  it("overlapWithNext mede a transição (a sobreposição)", () => {
    const t = tl([vtrack([media("a", 0, 3000), media("b", 2500, 2000, 0, "b.mp4")])]);
    expect(overlapWithNext(t.tracks[0], 0)).toBe(500);
    expect(overlapWithNext(t.tracks[0], 1)).toBe(0); // não há próximo
  });

  it("locate acha o clipe em qualquer trilha", () => {
    const t = tl([vtrack([media("a", 0, 1000)]), atrack([media("z", 0, 500, 0, "z.mp3")], "a1")]);
    expect(locate(t, "z")).toMatchObject({ ti: 1, ci: 0 });
    expect(locate(t, "nada")).toBeNull();
  });
});

describe("construção", () => {
  it("newTimeline: uma trilha de vídeo e uma de áudio, vazias", () => {
    const t = newTimeline();
    expect(t.tracks.map((tk) => tk.kind)).toEqual(["video", "audio"]);
    expect(clipCount(t)).toBe(0);
  });

  it("appendMedia põe no fim da trilha base, sem buraco", () => {
    let t = newTimeline();
    t = appendMedia(t, { path: "a.mp4", srcIn: 0, srcOut: 2000 });
    t = appendMedia(t, { path: "b.mp4", srcIn: 100, srcOut: 1100 });
    const base = baseVideoTrack(t)!;
    expect(base.clips.map((c) => [c.startMs, c.durationMs])).toEqual([
      [0, 2000],
      [2000, 1000],
    ]);
  });

  it("addTrack acrescenta no fim", () => {
    const t = addTrack(newTimeline(), "video");
    expect(t.tracks.map((tk) => tk.kind)).toEqual(["video", "audio", "video"]);
  });

  it("addTitle cria um clipe de texto na trilha de vídeo", () => {
    let tt = newTimeline();
    const vid = baseVideoTrack(tt)!.id;
    tt = addTitle(tt, vid, 1000, 3000, defaultTitle("Oi"));
    const clip = baseVideoTrack(tt)!.clips[0];
    expect(clip.title?.text).toBe("Oi");
    expect([clip.startMs, clip.durationMs]).toEqual([1000, 3000]);
    expect(clip.path).toBeUndefined();
  });
});

describe("splitAt", () => {
  it("vira um clipe em dois sem mudar a duração", () => {
    const t = splitAt(base(), "b", 1500);
    const track = t.tracks[0];
    expect(track.clips.length).toBe(4);
    expect(timelineDuration(t)).toBe(6000);
    expect(track.clips[1]).toMatchObject({ startMs: 1000, durationMs: 500, srcIn: 5000 });
    expect(track.clips[2]).toMatchObject({ startMs: 1500, durationMs: 1500, srcIn: 5500 });
    expect(track.clips[2].id).not.toBe(track.clips[1].id);
  });

  it("cortar na borda é não-evento", () => {
    const t = base();
    expect(splitAt(t, "a", 0)).toBe(t);
    expect(splitAt(t, "c", 6000)).toBe(t);
    expect(splitAt(t, "b", 1000)).toBe(t); // borda esquerda do b
  });

  it("corta um TÍTULO em dois (duas metades com o mesmo texto)", () => {
    let t = newTimeline();
    const vid = baseVideoTrack(t)!.id;
    t = addTitle(t, vid, 0, 4000, defaultTitle("X"));
    const id = baseVideoTrack(t)!.clips[0].id;
    t = splitAt(t, id, 1000);
    const clips = baseVideoTrack(t)!.clips;
    expect(clips.map((c) => [c.startMs, c.durationMs])).toEqual([
      [0, 1000],
      [1000, 3000],
    ]);
    expect(clips[0].title?.text).toBe("X");
    expect(clips[1].title?.text).toBe("X");
  });
});

describe("setClipEdge (aparar)", () => {
  it("borda IN: a esquerda anda e o srcIn anda junto", () => {
    // b: start 1000, dur 2000, srcIn 5000. Arrasta a esquerda pra 1300.
    const t = setClipEdge(base(), "b", "in", 1300);
    expect(t.tracks[0].clips[1]).toMatchObject({ startMs: 1300, durationMs: 1700, srcIn: 5300 });
  });

  it("borda IN não deixa srcIn ficar negativo", () => {
    // a tem srcIn 0: não pode recuar (srcIn ficaria <0). Grampeia no start → não-evento.
    const t0 = base();
    expect(setClipEdge(t0, "a", "in", -500)).toBe(t0);
  });

  it("borda OUT: só a duração muda, limitada pelo arquivo", () => {
    // a: start 0, dur 1000, srcIn 0. Estica pra 4000, mas o arquivo tem 2000.
    const t = setClipEdge(base(), "a", "out", 4000, 2000);
    expect(t.tracks[0].clips[0]).toMatchObject({ startMs: 0, durationMs: 2000 });
  });

  it("aparar a borda OUT pra trás demais grampeia num clipe mínimo (1 ms)", () => {
    // Não pode virar clipe de duração zero/negativa: o mínimo é 1 ms.
    const t = setClipEdge(base(), "a", "out", 0);
    expect(t.tracks[0].clips[0].durationMs).toBe(1);
  });
});

describe("setClipEdge — RIPPLE (aparar puxando os vizinhos)", () => {
  // base: a=[0,1000), b=[1000,3000)srcIn5000, c=[3000,6000)
  it("OUT encurtando: a fila sobe, sem buraco", () => {
    // Encurta 'a' pra 500. Ripple: b→500, c→2500 (colados).
    const t = setClipEdge(base(), "a", "out", 500, undefined, true);
    const [ca, cb, cc] = t.tracks[0].clips;
    expect(ca).toMatchObject({ startMs: 0, durationMs: 500 });
    expect(cb.startMs).toBe(500);
    expect(cc.startMs).toBe(2500);
    // b não mudou de conteúdo (srcIn intacto) — só de posição.
    expect(cb.srcIn).toBe(5000);
  });

  it("OUT esticando: a fila desce pelo mesmo tanto", () => {
    const t = setClipEdge(base(), "a", "out", 1500, undefined, true);
    const [ca, cb, cc] = t.tracks[0].clips;
    expect(ca.durationMs).toBe(1500);
    expect(cb.startMs).toBe(1500);
    expect(cc.startMs).toBe(3500);
  });

  it("IN cortando cabeça: o START fica colado, a cauda sobe, srcOut preservado", () => {
    const before = base().tracks[0].clips[1];
    const oldSrcOut = srcOut(before); // 7000
    const t = setClipEdge(base(), "b", "in", 1500, undefined, true);
    const cb = t.tracks[0].clips[1];
    const cc = t.tracks[0].clips[2];
    expect(cb.startMs).toBe(1000); // NÃO abriu buraco antes
    expect(cb.durationMs).toBe(1500); // 2000 - 500
    expect(cb.srcIn).toBe(5500); // avançou 500 de cabeça
    expect(srcOut(cb)).toBe(oldSrcOut); // o fim-fonte não mexeu
    expect(cc.startMs).toBe(2500); // cauda subiu 500 e colou no novo fim de b
  });

  it("IN devolvendo cabeça: a cauda desce, srcIn recua", () => {
    const t = setClipEdge(base(), "b", "in", 800, undefined, true);
    const cb = t.tracks[0].clips[1];
    const cc = t.tracks[0].clips[2];
    expect(cb.startMs).toBe(1000);
    expect(cb.durationMs).toBe(2200); // 2000 + 200
    expect(cb.srcIn).toBe(4800);
    expect(cc.startMs).toBe(3200); // desceu 200
  });

  it("ripple só mexe na PRÓPRIA trilha", () => {
    // Um clipe de áudio depois do fim de 'a' não pode andar por causa do ripple
    // na trilha de vídeo.
    const t0 = tl([
      vtrack([media("a", 0, 1000), media("b", 1000, 1000, 0, "b.mp4")]),
      atrack([media("mus", 1500, 2000, 0, "m.mp3")], "a1"),
    ]);
    const t = setClipEdge(t0, "a", "out", 500, undefined, true);
    expect(t.tracks[0].clips[1].startMs).toBe(500); // vídeo b subiu
    expect(t.tracks[1].clips[0].startMs).toBe(1500); // áudio intacto
  });
});

describe("moveClip", () => {
  it("move no tempo (mesma trilha)", () => {
    const t = moveClip(base(), "a", "v1", 4000);
    // a saiu do 0 pro 4000; a trilha re-ordena por startMs.
    const track = t.tracks[0];
    expect(track.clips.map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(track.clips.find((c) => c.id === "a")!.startMs).toBe(4000);
  });

  it("move pra outra trilha", () => {
    const t = moveClip(base(), "a", "a1", 0);
    expect(t.tracks[0].clips.map((c) => c.id)).toEqual(["b", "c"]);
    expect(t.tracks[1].clips.map((c) => c.id)).toEqual(["a"]);
  });

  it("título não vai pra trilha de áudio", () => {
    let t = newTimeline();
    const vid = baseVideoTrack(t)!.id;
    const aud = t.tracks[1].id;
    t = addTitle(t, vid, 0, 1000, defaultTitle("T"));
    const id = baseVideoTrack(t)!.clips[0].id;
    expect(moveClip(t, id, aud, 0)).toBe(t);
  });

  it("mover pro mesmo lugar é não-evento", () => {
    const t = base();
    expect(moveClip(t, "a", "v1", 0)).toBe(t);
  });
});

describe("removeClip / updateClip / setTransition", () => {
  it("remove tira só o clipe pedido", () => {
    const t = removeClip(base(), "b");
    expect(t.tracks[0].clips.map((c) => c.id)).toEqual(["a", "c"]);
    expect(removeClip(t, "zzz")).toBe(t);
  });

  it("updateClip muda propriedades sem mexer em posição", () => {
    const t = updateClip(base(), "a", { volume: 0.5, fadeInMs: 300 });
    expect(t.tracks[0].clips[0]).toMatchObject({ startMs: 0, volume: 0.5, fadeInMs: 300 });
    // Patch sem mudança é não-evento.
    expect(updateClip(t, "a", { volume: 0.5 })).toBe(t);
  });

  it("setTransition move o próximo pra dentro deste (sobreposição)", () => {
    // a=[0,1000), b começa em 1000. Transição de 400 → b passa a começar em 600.
    const t = setTransition(base(), "a", 400);
    expect(t.tracks[0].clips[1].startMs).toBe(600);
    expect(overlapWithNext(t.tracks[0], 0)).toBe(400);
  });

  it("transição é grampeada pela duração dos dois clipes", () => {
    // a dura 1000; pedir 5000 de transição só encosta até 1000.
    const t = setTransition(base(), "a", 5000);
    expect(overlapWithNext(t.tracks[0], 0)).toBe(1000);
  });
});

describe("setTransitionRipple — a transição de um clique (sem abrir buraco)", () => {
  it("cria a sobreposição puxando o seguinte E a fila atrás dele", () => {
    // a=[0,1000), b=[1000,3000), c=[3000,6000). Transição de 400 em a→b:
    // b vai pra 600 e c anda os MESMOS 400 (fica colado no fim de b, 2600).
    const t = setTransitionRipple(base(), "a", 400);
    expect(t.tracks[0].clips.map((c) => c.startMs)).toEqual([0, 600, 2600]);
    expect(overlapWithNext(t.tracks[0], 0)).toBe(400);
    // b–c continuam adjacentes: era o buraco que o setTransition simples abria.
    expect(overlapWithNext(t.tracks[0], 1)).toBe(0);
  });

  it("remover (0 ms) desfaz pelo mesmo caminho — a fila volta colada", () => {
    const withTrans = setTransitionRipple(base(), "a", 400);
    const t = setTransitionRipple(withTrans, "a", 0);
    expect(t.tracks[0].clips.map((c) => c.startMs)).toEqual([0, 1000, 3000]);
  });

  it("grampeia pela duração dos dois clipes, como a alça", () => {
    const t = setTransitionRipple(base(), "a", 5000);
    expect(overlapWithNext(t.tracks[0], 0)).toBe(1000);
  });

  it("é não-evento sem próximo, com título no par, ou sem mudança", () => {
    const t = base();
    expect(setTransitionRipple(t, "c", 400)).toBe(t); // último da trilha
    expect(setTransitionRipple(t, "zzz", 400)).toBe(t);
    const withTitle = tl([
      vtrack([media("a", 0, 1000), { id: "t1", startMs: 1000, durationMs: 2000, title: { text: "x", fontSizePx: 48, color: "#fff", anchor: "bottom" } }]),
    ]);
    expect(setTransitionRipple(withTitle, "a", 400)).toBe(withTitle);
    // Pedir a sobreposição que já existe é não-evento (mesma referência).
    const withTrans = setTransitionRipple(t, "a", 400);
    expect(setTransitionRipple(withTrans, "a", 400)).toBe(withTrans);
  });

  it("título por cima da emenda anda junto (não fica órfão do corte)", () => {
    // Um título que começa junto com b (legenda da cena) acompanha o ripple.
    const t0 = tl([
      vtrack([
        media("a", 0, 1000),
        media("b", 1000, 2000, 0, "b.mp4"),
        { id: "t1", startMs: 1000, durationMs: 500, title: { text: "x", fontSizePx: 48, color: "#fff", anchor: "bottom" } },
      ]),
    ]);
    const t = setTransitionRipple(t0, "a", 400);
    expect(t.tracks[0].clips.find((c) => c.id === "t1")!.startMs).toBe(600);
  });
});

describe("velocidade (P3) — a conta que muda a duração", () => {
  it("srcOut e srcWindow consideram a velocidade", () => {
    // dur 2000 na timeline @ 2× consome 4000 de fonte.
    const c: Clip = { id: "x", startMs: 0, durationMs: 2000, path: "a.mp4", srcIn: 1000, speed: 2 };
    expect(clipSpeed(c)).toBe(2);
    expect(srcWindowMs(c)).toBe(4000);
    expect(srcOut(c)).toBe(5000);
  });

  it("setClipSpeed preserva a fonte e encurta a timeline (2× = metade)", () => {
    // a=[0,1000) fonte[0,1000); b=[1000,2000) fonte[5000,7000); c=[3000,6000).
    // Acelera o b em 2×: fonte preservada (2000 ms), dur vira 1000, e o vizinho c
    // (que começava no fim de b, 3000) anda −1000.
    const t = setClipSpeed(base(), "b", 2);
    const track = t.tracks[0];
    const b = track.clips.find((x) => x.id === "b")!;
    expect(b.speed).toBe(2);
    expect(b.durationMs).toBe(1000);
    expect(srcOut(b)).toBe(7000); // fonte [5000,7000) intacta
    // c reposicionado: começava em 3000, delta −1000 → 2000.
    expect(track.clips.find((x) => x.id === "c")!.startMs).toBe(2000);
  });

  it("setClipSpeed câmera lenta (½×) dobra a duração e empurra o vizinho", () => {
    const t = setClipSpeed(base(), "b", 0.5);
    const b = t.tracks[0].clips.find((x) => x.id === "b")!;
    expect(b.durationMs).toBe(4000); // 2000 de fonte / 0.5
    expect(srcOut(b)).toBe(7000);
    // c começava em 3000; delta +2000 → 5000.
    expect(t.tracks[0].clips.find((x) => x.id === "c")!.startMs).toBe(5000);
  });

  it("velocidade é grampeada em 0.25..4 e título não tem velocidade", () => {
    const t = setClipSpeed(base(), "b", 99);
    expect(t.tracks[0].clips.find((x) => x.id === "b")!.speed).toBe(4);
    // Título: não-evento.
    let tt = newTimeline();
    const vid = baseVideoTrack(tt)!.id;
    tt = addTitle(tt, vid, 0, 1000, defaultTitle("T"));
    const id = baseVideoTrack(tt)!.clips[0].id;
    expect(setClipSpeed(tt, id, 2)).toBe(tt);
  });

  it("splitAt de um clipe acelerado divide a fonte proporcional à velocidade", () => {
    // clipe @2×: dur 2000 (fonte 4000). Corta em 1000 (metade da timeline) →
    // a direita começa 2000 adiante na fonte (1000 de timeline × 2).
    const t0 = tl([vtrack([{ id: "a", startMs: 0, durationMs: 2000, path: "a.mp4", srcIn: 0, speed: 2 }])]);
    const t = splitAt(t0, "a", 1000);
    const [left, right] = t.tracks[0].clips;
    expect([left.durationMs, left.srcIn, left.speed]).toEqual([1000, 0, 2]);
    expect([right.durationMs, right.srcIn, right.speed]).toEqual([1000, 2000, 2]);
  });

  it("timeToClip mapeia tempo-fonte pela velocidade", () => {
    const t = tl([vtrack([{ id: "a", startMs: 1000, durationMs: 2000, path: "a.mp4", srcIn: 500, speed: 2 }])]);
    // 500 ms depois do início na timeline → 1000 ms na fonte, a partir de 500.
    expect(timeToClip(t.tracks[0], 1500)?.srcTime).toBe(1500);
  });
});

describe("undo/redo", () => {
  it("desfaz e refaz um corte", () => {
    let h = initHistory(base());
    expect(canUndo(h)).toBe(false);
    h = pushHistory(h, splitAt(h.present, "b", 1500));
    expect(h.present.tracks[0].clips.length).toBe(4);
    h = undo(h);
    expect(h.present.tracks[0].clips.length).toBe(3);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present.tracks[0].clips.length).toBe(4);
  });

  it("um arrasto inteiro (mover/aparar) é UM passo de undo", () => {
    let h = initHistory(base());
    const antes = h.present;
    h = pushHistory(h, moveClip(h.present, "a", "v1", 100)); // 1º movimento
    for (let x = 120; x <= 300; x += 20) {
      h = replacePresent(h, moveClip(h.present, "a", "v1", x)); // resto do arrasto
    }
    expect(h.past.length).toBe(1);
    h = undo(h);
    expect(h.present).toBe(antes);
    expect(canUndo(h)).toBe(false);
  });

  it("não-evento não entra no histórico", () => {
    let h = initHistory(base());
    h = pushHistory(h, splitAt(h.present, "a", 0)); // corte na borda = nada
    expect(canUndo(h)).toBe(false);
  });

  it("o estado antigo não é mutado", () => {
    const original = base();
    let h = initHistory(original);
    h = pushHistory(h, updateClip(h.present, "a", { volume: 2 }));
    h = undo(h);
    expect(h.present).toBe(original);
    expect(original.tracks[0].clips[0].volume).toBeUndefined();
  });
});

describe("detachAudio — separar o áudio do vídeo", () => {
  it("cala o vídeo e cria uma trilha de áudio no mesmo lugar", () => {
    __resetIds();
    let tl = newTimeline();
    tl = appendMedia(tl, { path: "a.mp4", srcIn: 0, srcOut: 5000 });
    const vid = tl.tracks[0].clips[0];

    tl = detachAudio(tl, vid.id, 1);

    // O vídeo original ficou mudo (o áudio não some, só para de tocar por ele).
    expect(locate(tl, vid.id)!.clip.muted).toBe(true);
    // O áudio foi pra uma trilha de áudio (reusa a vazia que o newTimeline traz).
    const at = tl.tracks.find((t) => t.kind === "audio" && t.clips.length > 0)!;
    expect(at).toBeTruthy();
    expect(at.clips).toHaveLength(1);
    const a = at.clips[0];
    expect(a.startMs).toBe(vid.startMs);
    expect(a.durationMs).toBe(vid.durationMs);
    expect(a.path).toBe("a.mp4");
    expect(a.audioStreamIndex).toBe(0);
  });

  it("duas faixas viram DOIS clipes de áudio, cada um na sua faixa-fonte", () => {
    // O caso do LocalRecord: mic (0) + áudio do sistema (1).
    __resetIds();
    let tl = newTimeline();
    tl = appendMedia(tl, { path: "rec.mp4", srcIn: 0, srcOut: 5000 });
    const vid = tl.tracks[0].clips[0];

    tl = detachAudio(tl, vid.id, 2);

    const audio = tl.tracks.filter((t) => t.kind === "audio" && t.clips.length > 0);
    // Duas faixas no mesmo trecho de tempo => duas trilhas (senão se sobreporiam).
    expect(audio).toHaveLength(2);
    const idxs = audio.flatMap((t) => t.clips.map((c) => c.audioStreamIndex)).sort();
    expect(idxs).toEqual([0, 1]);
  });

  it("clipe já mudo ou título não faz nada (idempotente)", () => {
    __resetIds();
    let tl = newTimeline();
    tl = appendMedia(tl, { path: "a.mp4", srcIn: 0, srcOut: 5000 });
    const id = tl.tracks[0].clips[0].id;
    const mudo = detachAudio(tl, id, 1);
    // segunda vez sobre o clipe já mudo: nada muda
    expect(detachAudio(mudo, id, 1)).toBe(mudo);
  });
});

describe("addSubtitles — legenda vira clipe de titulo editavel", () => {
  it("cada cue vira um clipe numa trilha nova por cima", () => {
    __resetIds();
    let tl = newTimeline();
    tl = addSubtitles(tl, [
      { startMs: 1000, durationMs: 2000, text: "um" },
      { startMs: 4000, durationMs: 1000, text: "dois" },
    ]);
    const sub = tl.tracks[tl.tracks.length - 1];
    expect(sub.kind).toBe("video");
    expect(sub.clips).toHaveLength(2);
    expect(sub.clips[0].title!.text).toBe("um");
    expect(sub.clips[0].title!.anchor).toBe("bottom");
    expect(sub.clips[0].startMs).toBe(1000);
  });

  it("cue que invadiria o proximo e aparado (senao vira crossfade)", () => {
    __resetIds();
    let tl = newTimeline();
    // A primeira legenda diz durar 5s, mas a segunda comeca em 2s.
    tl = addSubtitles(tl, [
      { startMs: 0, durationMs: 5000, text: "longa" },
      { startMs: 2000, durationMs: 1000, text: "curta" },
    ]);
    const sub = tl.tracks[tl.tracks.length - 1];
    // Encurtada pra nao passar do inicio da seguinte.
    expect(sub.clips[0].durationMs).toBe(2000);
  });

  it("lista vazia nao mexe na timeline", () => {
    const tl = newTimeline();
    expect(addSubtitles(tl, [])).toBe(tl);
  });
});

describe("splitTargetId — o S corta o clipe SELECIONADO, não a trilha base", () => {
  /** V1 com um clipe 0..6000; A1 com um clipe 1000..5000 (áudio destacado). */
  const dois = (): Timeline =>
    tl([
      vtrack([media("v", 0, 6000, 0, "v.mp4")]),
      atrack([media("a", 1000, 4000, 0, "v.mp4")], "a1"),
    ]);

  it("REGRESSÃO: com um clipe de trilha NÃO-BASE selecionado, corta ELE", () => {
    // É o bug: até a v0.7 o doSplit perguntava sempre ao `baseVideoTrack`, então
    // com o áudio separado selecionado o S cortava o vídeo lá embaixo.
    expect(splitTargetId(dois(), "a", 2000)).toBe("a");
  });

  it("com o playhead FORA do clipe selecionado, cai na trilha base", () => {
    // 500 ms: o clipe de áudio ainda não começou; o vídeo está tocando.
    expect(splitTargetId(dois(), "a", 500)).toBe("v");
  });

  it("sem seleção, é a trilha base (comportamento de sempre)", () => {
    expect(splitTargetId(dois(), null, 2000)).toBe("v");
  });

  it("em cima da borda do selecionado não corta ele (cai na base)", () => {
    expect(splitTargetId(dois(), "a", 1000)).toBe("v");
  });

  it("playhead num buraco sem seleção: não há o que cortar", () => {
    const vazio = tl([vtrack([media("v", 0, 1000)]), atrack([])]);
    expect(splitTargetId(vazio, null, 5000)).toBeNull();
  });

  it("de fato CORTA a trilha não-base ponta a ponta (S de verdade)", () => {
    const t0 = dois();
    const id = splitTargetId(t0, "a", 3000)!;
    const t1 = splitAt(t0, id, 3000);
    const at = t1.tracks[1];
    expect(at.clips.map((c) => [c.startMs, c.durationMs])).toEqual([
      [1000, 2000],
      [3000, 2000],
    ]);
    // O vídeo da base NÃO foi tocado.
    expect(t1.tracks[0].clips).toHaveLength(1);
  });
});

describe("removeClipRipple — o Del que fecha o buraco", () => {
  it("puxa os seguintes da MESMA trilha o tamanho do que saiu", () => {
    // base: a=[0,1000) b=[1000,3000) c=[3000,6000). Removendo b (2000 ms),
    // c tem que subir pra 1000 — sem buraco.
    const out = removeClipRipple(base(), "b");
    expect(out.tracks[0].clips.map((c) => [c.id, c.startMs, c.durationMs])).toEqual([
      ["a", 0, 1000],
      ["c", 1000, 3000],
    ]);
    expect(timelineDuration(out)).toBe(4000);
  });

  it("quem vem ANTES fica parado", () => {
    const out = removeClipRipple(base(), "c");
    expect(out.tracks[0].clips.map((c) => c.startMs)).toEqual([0, 1000]);
  });

  it("não mexe nas OUTRAS trilhas (a música de fundo não pode dessincronizar)", () => {
    const t0 = tl([
      vtrack([media("a", 0, 1000), media("b", 1000, 2000)]),
      atrack([media("m", 0, 3000, 0, "m.mp3")], "a1"),
    ]);
    const out = removeClipRipple(t0, "a");
    expect(out.tracks[1].clips[0].startMs).toBe(0);
    expect(out.tracks[0].clips.map((c) => c.startMs)).toEqual([0]);
  });

  it("id que não existe devolve a MESMA timeline (sem passo de undo à toa)", () => {
    const t0 = base();
    expect(removeClipRipple(t0, "zzz")).toBe(t0);
  });

  it("sem ripple, o removeClip normal continua deixando o buraco", () => {
    const out = removeClip(base(), "b");
    expect(out.tracks[0].clips.map((c) => c.startMs)).toEqual([0, 3000]);
  });
});

describe("duplicateClip — Ctrl+D", () => {
  it("põe a cópia logo depois e EMPURRA quem vinha atrás", () => {
    // Duplicar b (1000..3000): a cópia entra em 3000 e c vai de 3000 pra 5000.
    const out = duplicateClip(base(), "b");
    expect(out.tracks[0].clips.map((c) => [c.startMs, c.durationMs])).toEqual([
      [0, 1000],
      [1000, 2000],
      [3000, 2000],
      [5000, 3000],
    ]);
  });

  it("a cópia leva as propriedades mas NUNCA o id", () => {
    const t0 = tl([
      vtrack([{ ...media("b", 0, 2000, 5000, "b.mp4"), volume: 0.4, speed: 2, audioStreamIndex: 1 }]),
      atrack([]),
    ]);
    const out = duplicateClip(t0, "b");
    const [orig, copy] = out.tracks[0].clips;
    expect(copy.id).not.toBe(orig.id);
    expect(copy.volume).toBe(0.4);
    expect(copy.speed).toBe(2);
    expect(copy.audioStreamIndex).toBe(1);
    expect(copy.srcIn).toBe(5000);
    // Encostada, não sobreposta: sobreposição É transição neste modelo, e um
    // crossfade de brinde seria um efeito que ninguém pediu.
    expect(copy.startMs).toBe(clipEnd(orig));
    expect(overlapWithNext(out.tracks[0], 0)).toBe(0);
  });

  it("duplica em trilha NÃO-base também (o áudio destacado)", () => {
    const t0 = tl([vtrack([media("v", 0, 6000)]), atrack([media("a", 0, 2000)], "a1")]);
    const out = duplicateClip(t0, "a");
    expect(out.tracks[1].clips.map((c) => c.startMs)).toEqual([0, 2000]);
    expect(out.tracks[0].clips).toHaveLength(1);
  });

  it("id inexistente devolve a MESMA timeline", () => {
    const t0 = base();
    expect(duplicateClip(t0, "zzz")).toBe(t0);
  });
});

/* ------------------------------------------------------------------ */
/* Trilhas: mudo, remover, reordenar (v0.9 — F5)                       */
/* ------------------------------------------------------------------ */

describe("setTrackMuted — o interruptor de camada", () => {
  it("liga o mudo e é não-evento quando já está ligado", () => {
    const t0 = tl([vtrack([media("v", 0, 3000)]), atrack([media("a", 0, 3000)])]);
    const on = setTrackMuted(t0, "a1", true);
    expect(on.tracks[1].muted).toBe(true);
    // Clicar de novo no mesmo estado não pode gastar um passo de undo.
    expect(setTrackMuted(on, "a1", true)).toBe(on);
    // A trilha de cima não foi tocada (identidade preservada).
    expect(on.tracks[0]).toBe(t0.tracks[0]);
  });

  it("desligar REMOVE a chave (não grava `muted: false`)", () => {
    const t0 = tl([vtrack([]), atrack([], "a1")]);
    const off = setTrackMuted(setTrackMuted(t0, "a1", true), "a1", false);
    expect("muted" in off.tracks[1]).toBe(false);
  });

  it("trilha inexistente é não-evento", () => {
    const t0 = tl([vtrack([])]);
    expect(setTrackMuted(t0, "zzz", true)).toBe(t0);
  });
});

describe("canRemoveTrack / removeTrack — a trilha deixa de ser pra sempre", () => {
  it("remove uma trilha de áudio com os clipes dentro", () => {
    const t0 = tl([vtrack([media("v", 0, 3000)]), atrack([media("a", 0, 3000)])]);
    const out = removeTrack(t0, "a1");
    expect(out.tracks).toHaveLength(1);
    expect(locate(out, "a")).toBeNull();
  });

  it("a ÚLTIMA trilha de vídeo não sai — o projeto não reabriria sem ela", () => {
    const t0 = tl([vtrack([]), atrack([])]);
    expect(canRemoveTrack(t0, "v1")).toBe(false);
    expect(removeTrack(t0, "v1")).toBe(t0);
    // Com duas, a de cima já pode sair.
    const t1 = tl([vtrack([], "v1"), vtrack([], "v2"), atrack([])]);
    expect(canRemoveTrack(t1, "v1")).toBe(true);
    expect(removeTrack(t1, "v1").tracks.map((t) => t.id)).toEqual(["v2", "a1"]);
  });

  it("a última trilha de ÁUDIO sai sem trava (o detach cria outra quando precisa)", () => {
    const t0 = tl([vtrack([]), atrack([])]);
    expect(canRemoveTrack(t0, "a1")).toBe(true);
    expect(removeTrack(t0, "a1").tracks).toHaveLength(1);
  });
});

describe("moveTrack — reordenar entre as do MESMO tipo", () => {
  const t0 = () => tl([vtrack([], "v1"), vtrack([], "v2"), atrack([], "a1"), atrack([], "a2")]);

  it("sobe/desce trocando com a vizinha do mesmo tipo", () => {
    expect(moveTrack(t0(), "v2", -1).tracks.map((t) => t.id)).toEqual(["v2", "v1", "a1", "a2"]);
    expect(moveTrack(t0(), "a1", 1).tracks.map((t) => t.id)).toEqual(["v1", "v2", "a2", "a1"]);
  });

  it("PULA as de outro tipo em vez de atravessar o bloco", () => {
    // "v2" descendo procura outra de VÍDEO abaixo; não há, então é não-evento
    // (não vai parar no meio das de áudio, onde a ordem não significaria nada).
    const t = t0();
    expect(moveTrack(t, "v2", 1)).toBe(t);
    expect(moveTrack(t, "a1", -1)).toBe(t);
  });

  it("nas pontas e com id inexistente é não-evento", () => {
    const t = t0();
    expect(moveTrack(t, "v1", -1)).toBe(t);
    expect(moveTrack(t, "a2", 1)).toBe(t);
    expect(moveTrack(t, "zzz", -1)).toBe(t);
  });

  it("subir a 2ª trilha de vídeo a torna a BASE (é o rótulo seguindo a ordem)", () => {
    const t = tl([vtrack([media("a", 0, 1000)], "v1"), vtrack([media("b", 0, 1000)], "v2")]);
    expect(baseVideoTrack(t)!.id).toBe("v1");
    expect(baseVideoTrack(moveTrack(t, "v2", -1))!.id).toBe("v2");
  });
});

/* ------------------------------------------------------------------ */
/* Painel de mídia (v0.11): soltar do pool na régua                     */
/* ------------------------------------------------------------------ */

describe("insertMediaAt — o arrasto do painel de mídia", () => {
  it("solta ONDE mandaram, na trilha que mandaram", () => {
    const t = insertMediaAt(base(), "v1", 8000, { path: "novo.mp4", srcIn: 0, srcOut: 2000 });
    const c = t.tracks[0].clips.find((c) => c.path === "novo.mp4")!;
    expect(c.startMs).toBe(8000);
    expect(c.durationMs).toBe(2000);
    expect(c.srcIn).toBe(0);
    // Buraco entre 6000 e 8000 é permitido: soltar longe é uma escolha, não erro.
    expect(timelineDuration(t)).toBe(10_000);
  });

  it("respeita o srcIn (soltar um trecho, não o arquivo do zero)", () => {
    const t = insertMediaAt(base(), "v1", 0, { path: "n.mp4", srcIn: 1500, srcOut: 4000 });
    const c = t.tracks[0].clips.find((x) => x.path === "n.mp4")!;
    expect(c.srcIn).toBe(1500);
    expect(c.durationMs).toBe(2500);
  });

  it("cai numa trilha de ÁUDIO (soltar só a música)", () => {
    const t = insertMediaAt(base(), "a1", 500, { path: "musica.mp3", srcIn: 0, srcOut: 9000 });
    expect(t.tracks[1].clips).toHaveLength(1);
    expect(t.tracks[1].clips[0].startMs).toBe(500);
  });

  it("mantém a trilha ORDENADA por startMs (o resto do módulo conta com isso)", () => {
    const t = insertMediaAt(base(), "v1", 1500, { path: "n.mp4", srcIn: 0, srcOut: 100 });
    const starts = t.tracks[0].clips.map((c) => c.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("start negativo vira 0 — não há tempo antes do começo do filme", () => {
    const t = insertMediaAt(base(), "v1", -5000, { path: "n.mp4", srcIn: 0, srcOut: 1000 });
    expect(t.tracks[0].clips.find((c) => c.path === "n.mp4")!.startMs).toBe(0);
  });

  it("trilha inexistente ou duração zero é NÃO-EVENTO (mesma referência)", () => {
    const t = base();
    expect(insertMediaAt(t, "zzz", 0, { path: "n.mp4", srcIn: 0, srcOut: 1000 })).toBe(t);
    expect(insertMediaAt(t, "v1", 0, { path: "n.mp4", srcIn: 500, srcOut: 500 })).toBe(t);
    expect(insertMediaAt(t, "v1", 0, { path: "n.mp4", srcIn: 900, srcOut: 100 })).toBe(t);
  });

  it("não empurra ninguém: soltar em cima SOBREPÕE (como o moveClip)", () => {
    const t = insertMediaAt(base(), "v1", 1000, { path: "n.mp4", srcIn: 0, srcOut: 500 });
    // Os três originais ficam exatamente onde estavam.
    expect(t.tracks[0].clips.filter((c) => c.path !== "n.mp4").map((c) => c.startMs)).toEqual([
      0, 1000, 3000,
    ]);
  });
});

describe("mediaUsageCount — quantos clipes usam este arquivo", () => {
  it("conta em TODAS as trilhas, e zero pra quem só está no pool", () => {
    const t = tl([
      vtrack([media("a", 0, 1000, 0, "x.mp4"), media("b", 1000, 1000, 0, "x.mp4")]),
      atrack([media("c", 0, 1000, 0, "x.mp4")], "a1"),
    ]);
    expect(mediaUsageCount(t, "x.mp4")).toBe(3);
    expect(mediaUsageCount(t, "so-no-pool.mp4")).toBe(0);
  });

  it("título não tem path e não conta", () => {
    const t = tl([
      vtrack([{ id: "t1", startMs: 0, durationMs: 1000, title: defaultTitle("oi") }]),
    ]);
    expect(mediaUsageCount(t, "x.mp4")).toBe(0);
  });
});
