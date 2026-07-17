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
  streamCount: 1,
  sizeBytes: 100,
});

const timeline: Timeline = {
  version: 2,
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

describe(".tvproj v2", () => {
  it("salva e abre sem perder nada (ida e volta)", () => {
    const media = { "C:\\v1.mp4": info("C:\\v1.mp4"), "C:\\v2.mp4": info("C:\\v2.mp4") };
    const back = parseProject(serializeProject(timeline, media));
    expect(back.timeline).toEqual(timeline);
    expect(back.media["C:\\v1.mp4"].frameRate).toBe("30000/1001");
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
    expect(tl.version).toBe(2);
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
