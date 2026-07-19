import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetMigrationIds,
  ProjectParseError,
  parseProject,
  serializeProject,
  TVPROJ_VERSION,
} from "../project";
import type { RawMediaInfo } from "../probe";
import { timelineDuration, type Timeline } from "../timeline";

const info = (path: string): RawMediaInfo => ({
  path,
  durationMs: 10000,
  width: 640,
  height: 480,
  frameRate: "30000/1001",
  avgFrameRate: "30000/1001",
  videoCodec: "h264",
  audioCodec: null,
  hasAudio: false,
      audioTracks: [],
  streamCount: 1,
  sizeBytes: 100,
});

const timeline: Timeline = {
  version: 3,
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        { id: "a", startMs: 0, durationMs: 1000, path: "C:\\v1.mp4", srcIn: 0 },
        { id: "b", startMs: 1000, durationMs: 1500, path: "C:\\v2.mp4", srcIn: 500 },
        { id: "t", startMs: 500, durationMs: 800, title: { text: "Oi", fontSizePx: 40, color: "#ff0000", anchor: "top" } },
      ],
    },
    { id: "a1", kind: "audio", clips: [] },
  ],
};

beforeEach(() => __resetMigrationIds());

describe(".tvproj v3 (formato corrente)", () => {
  it("salva e abre sem perder nada (ida e volta)", () => {
    const media = { "C:\\v1.mp4": info("C:\\v1.mp4"), "C:\\v2.mp4": info("C:\\v2.mp4") };
    const back = parseProject(serializeProject(timeline, media));
    expect(back.timeline).toEqual(timeline);
    expect(back.media["C:\\v1.mp4"].frameRate).toBe("30000/1001");
  });

  it("guarda e reabre os filtros/velocidade/keyframes da v0.3 (ida e volta)", () => {
    const v3: Timeline = {
      version: 3,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "a",
              startMs: 0,
              durationMs: 2000,
              path: "C:\\v1.mp4",
              srcIn: 0,
              speed: 2,
              crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
              transform: { x: 0.6, y: 0.6, scale: 0.35 },
              color: { brightness: 0.2, contrast: 1.3, saturation: 0.8 },
              opacityKeyframes: [
                { t: 0, v: 0 },
                { t: 1, v: 1 },
              ],
              volumeKeyframes: [
                { t: 0, v: 1 },
                { t: 1, v: 0.5 },
              ],
            },
          ],
        },
        { id: "a1", kind: "audio", clips: [] },
      ],
    };
    const back = parseProject(serializeProject(v3, { "C:\\v1.mp4": info("C:\\v1.mp4") }));
    // Nada se perde nem se distorce no disco.
    expect(back.timeline).toEqual(v3);
  });

  it("guarda e reabre o tipo da transição (v0.4.1) — e joga fora valor inventado", () => {
    const withTrans: Timeline = {
      version: 3,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "a", startMs: 0, durationMs: 3000, path: "C:\\v1.mp4", srcIn: 0, transitionKind: "wipe" },
            { id: "b", startMs: 2000, durationMs: 3000, path: "C:\\v2.mp4", srcIn: 0, transitionKind: "slide" },
          ],
        },
        { id: "a1", kind: "audio", clips: [] },
      ],
    };
    const media = { "C:\\v1.mp4": info("C:\\v1.mp4"), "C:\\v2.mp4": info("C:\\v2.mp4") };
    const back = parseProject(serializeProject(withTrans, media));
    expect(back.timeline).toEqual(withTrans);

    // Valor desconhecido (arquivo editado à mão) NÃO entra: vira o dissolve
    // padrão em vez de derrubar o projeto ou vazar lixo pro compilador.
    const doc =
      '{"app":"LocalVideo","version":2,"media":{},"tracks":[{"id":"v1","kind":"video","clips":[' +
      '{"id":"a","startMs":0,"durationMs":1000,"path":"v.mp4","srcIn":0,"transitionKind":"explode"}]}]}';
    expect(parseProject(doc).timeline.tracks[0].clips[0].transitionKind).toBeUndefined();
  });

  it("guarda e reabre a DIREÇÃO do wipe/slide (v0.9.2), sem bump de versão", () => {
    const comDir: Timeline = {
      version: 3,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "a",
              startMs: 0,
              durationMs: 3000,
              path: "C:\\v1.mp4",
              srcIn: 0,
              transitionKind: "wipe",
              transitionDir: "bt",
            },
            { id: "b", startMs: 2000, durationMs: 3000, path: "C:\\v2.mp4", srcIn: 0 },
          ],
        },
        { id: "a1", kind: "audio", clips: [] },
      ],
    };
    const media = { "C:\\v1.mp4": info("C:\\v1.mp4"), "C:\\v2.mp4": info("C:\\v2.mp4") };
    const back = parseProject(serializeProject(comDir, media));
    expect(back.timeline).toEqual(comDir);
    // A versão do arquivo NÃO subiu: campo novo e opcional, e o app antigo que
    // ignora a chave continua vendo um wipe (na direção padrão) em vez de perder
    // a transição. Foi o que dispensou o bump — ver `TransitionDir`.
    expect(JSON.parse(serializeProject(comDir, media)).version).toBe(3);

    // Direção inventada (arquivo editado à mão) não entra: cai no `lr` padrão,
    // e o clipe continua com o wipe que o usuário escolheu.
    const doc =
      '{"app":"LocalVideo","version":3,"media":{},"tracks":[{"id":"v1","kind":"video","clips":[' +
      '{"id":"a","startMs":0,"durationMs":1000,"path":"v.mp4","srcIn":0,' +
      '"transitionKind":"wipe","transitionDir":"diagonal"}]}]}';
    const c = parseProject(doc).timeline.tracks[0].clips[0];
    expect(c.transitionDir).toBeUndefined();
    expect(c.transitionKind).toBe("wipe");
  });

  it("guarda e reabre a FAIXA de áudio de cada clipe (audioStreamIndex)", () => {
    // O cenário do take do LocalRecord: áudio separado em dois clipes, um por
    // faixa. Sem o round-trip, salvar e reabrir devolvia os DOIS apontando pra
    // faixa 0 — o "Áudio do sistema" virava um segundo microfone, calado, e só
    // no export alguém notava.
    const detached: Timeline = {
      version: 3,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [{ id: "a", startMs: 0, durationMs: 2000, path: "C:\\take.mp4", srcIn: 0, muted: true }],
        },
        {
          id: "a1",
          kind: "audio",
          clips: [{ id: "m", startMs: 0, durationMs: 2000, path: "C:\\take.mp4", srcIn: 0, audioStreamIndex: 0 }],
        },
        {
          id: "a2",
          kind: "audio",
          clips: [{ id: "s", startMs: 0, durationMs: 2000, path: "C:\\take.mp4", srcIn: 0, audioStreamIndex: 1 }],
        },
      ],
    };
    const back = parseProject(serializeProject(detached, { "C:\\take.mp4": info("C:\\take.mp4") }));
    expect(back.timeline).toEqual(detached);

    // Índice inventado no disco (negativo/não-número) NÃO entra: o clipe cai na
    // faixa 0 implícita em vez de mandar um `a:-2` pro ffmpeg.
    const doc =
      '{"app":"LocalVideo","version":2,"media":{},"tracks":[' +
      '{"id":"v1","kind":"video","clips":[]},{"id":"a1","kind":"audio","clips":[' +
      '{"id":"x","startMs":0,"durationMs":1000,"path":"v.mp4","srcIn":0,"audioStreamIndex":-2}]}]}';
    expect(parseProject(doc).timeline.tracks[1].clips[0].audioStreamIndex).toBeUndefined();
  });

  it("ignora filtros malformados no disco (não abre pela metade com lixo)", () => {
    const doc =
      '{"app":"LocalVideo","version":2,"media":{},"tracks":[{"id":"v1","kind":"video","clips":[' +
      '{"id":"a","startMs":0,"durationMs":1000,"path":"v.mp4","srcIn":0,"crop":{"x":"x"},"speed":-1,"opacityKeyframes":"nope"}]}]}';
    const { timeline: tl } = parseProject(doc);
    const c = tl.tracks[0].clips[0];
    // Crop inválido, speed inválido e keyframes inválidos são descartados —
    // o clipe abre sem eles, não quebra o projeto.
    expect(c.crop).toBeUndefined();
    expect(c.speed).toBeUndefined();
    expect(c.opacityKeyframes).toBeUndefined();
  });

  it("não guarda mídia órfã (arquivo sem clipe sai do projeto)", () => {
    const media = {
      "C:\\v1.mp4": info("C:\\v1.mp4"),
      "C:\\v2.mp4": info("C:\\v2.mp4"),
      "C:\\sumiu.mp4": info("C:\\sumiu.mp4"),
    };
    const doc = JSON.parse(serializeProject(timeline, media));
    expect(Object.keys(doc.media).sort()).toEqual(["C:\\v1.mp4", "C:\\v2.mp4"]);
    expect(doc.app).toBe("LocalVideo");
    expect(doc.version).toBe(TVPROJ_VERSION);
  });

  it("recusa arquivo que não é nosso, e não finge que abriu", () => {
    expect(() => parseProject("{isso não é json")).toThrow(ProjectParseError);
    expect(() => parseProject('{"app":"OutroApp","version":2,"tracks":[]}')).toThrow(ProjectParseError);
    expect(() => parseProject("null")).toThrow(ProjectParseError);
  });

  it("recusa projeto de versão FUTURA", () => {
    expect(() => parseProject('{"app":"LocalVideo","version":99,"tracks":[]}')).toThrow(/newer/);
  });

  it("recusa clipe corrompido em vez de abrir pela metade", () => {
    const bad = (c: string) =>
      `{"app":"LocalVideo","version":2,"media":{},"tracks":[{"id":"v1","kind":"video","clips":[${c}]}]}`;
    // sem duração
    expect(() => parseProject(bad('{"id":"a","startMs":0,"path":"v.mp4","srcIn":0}'))).toThrow();
    // nem mídia nem título
    expect(() => parseProject(bad('{"id":"a","startMs":0,"durationMs":10}'))).toThrow();
    // duração <= 0
    expect(() => parseProject(bad('{"id":"a","startMs":0,"durationMs":0,"path":"v.mp4"}'))).toThrow();
  });
});

describe(".tvproj v1 → migração (o projeto da v0.1 TEM que abrir)", () => {
  it("clipes em fila viram uma trilha de vídeo com startMs acumulado", () => {
    // Um .tvproj REAL da v0.1: version 1, lista rasa de clipes.
    const v1 = JSON.stringify({
      app: "LocalVideo",
      version: 1,
      media: { "C:\\a.mp4": info("C:\\a.mp4") },
      clips: [
        { id: "c1", path: "C:\\a.mp4", srcIn: 0, srcOut: 2000 },
        { id: "c2", path: "C:\\a.mp4", srcIn: 5000, srcOut: 8000 },
      ],
    });
    const { timeline: tl, media } = parseProject(v1);
    expect(tl.version).toBe(3);
    expect(tl.tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
    // Posições acumuladas: c1 em 0 (2s), c2 logo depois em 2000 (3s).
    expect(tl.tracks[0].clips.map((c) => [c.startMs, c.durationMs, c.srcIn])).toEqual([
      [0, 2000, 0],
      [2000, 3000, 5000],
    ]);
    expect(timelineDuration(tl)).toBe(5000);
    expect(media["C:\\a.mp4"].width).toBe(640);
  });

  it("v1 vazia migra pra uma timeline vazia com trilhas", () => {
    const v1 = '{"app":"LocalVideo","version":1,"media":{},"clips":[]}';
    const { timeline: tl } = parseProject(v1);
    expect(tl.tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
    expect(tl.tracks[0].clips).toEqual([]);
  });

  it("v1 com clipe corrompido não abre pela metade", () => {
    const v1 = '{"app":"LocalVideo","version":1,"media":{},"clips":[{"path":"","srcIn":0,"srcOut":10}]}';
    expect(() => parseProject(v1)).toThrow(ProjectParseError);
  });
});

describe(".tvproj — mudo e ordem de trilha (v0.9)", () => {
  const media = { "C:\v1.mp4": info("C:\v1.mp4"), "C:\v2.mp4": info("C:\v2.mp4") };
  const muted: Timeline = {
    ...timeline,
    tracks: [timeline.tracks[0], { ...timeline.tracks[1], muted: true }],
  };

  it("o mudo sobrevive ao salvar/abrir", () => {
    const back = parseProject(serializeProject(muted, media));
    expect(back.timeline.tracks[1].muted).toBe(true);
    expect(back.timeline.tracks[0].muted).toBeUndefined();
  });

  it("a ORDEM das trilhas é o próprio array — reordenar viaja sem campo novo", () => {
    const trocado: Timeline = { ...timeline, tracks: [...timeline.tracks].reverse() };
    const back = parseProject(serializeProject(trocado, media));
    expect(back.timeline.tracks.map((t) => t.id)).toEqual(["a1", "v1"]);
  });

  it("o arquivo declara `version: 3` — o bump é o que impede perda calada", () => {
    // Campo OPCIONAL não muda o contrato: um app antigo abre este projeto (só
    // perde o mudo). Bumpar faria o app antigo RECUSAR o arquivo, que é bem pior.
    expect(JSON.parse(serializeProject(muted, media)).version).toBe(3);
  });

  it("projeto SEM o campo abre com as trilhas soando (o padrão por omissão)", () => {
    const back = parseProject(serializeProject(timeline, media));
    expect(back.timeline.tracks.every((t) => t.muted === undefined)).toBe(true);
  });

  it("`muted: false` gravado à mão vira ausência (é o mesmo estado)", () => {
    const doc = JSON.parse(serializeProject(timeline, media));
    doc.tracks[1].muted = false;
    expect("muted" in parseProject(JSON.stringify(doc)).timeline.tracks[1]).toBe(false);
  });

  it("`muted` com lixo no lugar do booleano não derruba o projeto", () => {
    const doc = JSON.parse(serializeProject(timeline, media));
    doc.tracks[1].muted = "sim";
    expect(parseProject(JSON.stringify(doc)).timeline.tracks[1].muted).toBeUndefined();
  });
});
