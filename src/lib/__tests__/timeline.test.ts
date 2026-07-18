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
  canUndo,
  clipEnd,
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
  replacePresent,
  setClipEdge,
  setClipSpeed,
  setTransition,
  splitAt,
  srcOut,
  srcWindowMs,
  timelineDuration,
  timeToClip,
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
