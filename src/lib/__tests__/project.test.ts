import { describe, expect, it } from "vitest";
import { ProjectParseError, parseProject, serializeProject, TVPROJ_VERSION } from "../project";
import type { RawMediaInfo } from "../probe";
import type { Track } from "../timeline";

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

const track: Track = {
  clips: [
    { id: "a", path: "C:\\v1.mp4", srcIn: 0, srcOut: 1000 },
    { id: "b", path: "C:\\v2.mp4", srcIn: 500, srcOut: 2000 },
  ],
};

describe(".tvproj", () => {
  it("salva e abre sem perder nada (ida e volta)", () => {
    const media = { "C:\\v1.mp4": info("C:\\v1.mp4"), "C:\\v2.mp4": info("C:\\v2.mp4") };
    const back = parseProject(serializeProject(track, media));
    expect(back.track).toEqual(track);
    expect(back.media["C:\\v1.mp4"].frameRate).toBe("30000/1001");
  });

  it("não guarda mídia órfã (arquivo sem clipe sai do projeto)", () => {
    const media = { "C:\\v1.mp4": info("C:\\v1.mp4"), "C:\\sumiu.mp4": info("C:\\sumiu.mp4") };
    const doc = JSON.parse(serializeProject({ clips: [track.clips[0]] }, media));
    expect(Object.keys(doc.media)).toEqual(["C:\\v1.mp4"]);
    expect(doc.app).toBe("LocalVideo");
    expect(doc.version).toBe(TVPROJ_VERSION);
  });

  it("recusa arquivo que não é nosso, e não finge que abriu", () => {
    expect(() => parseProject("{isso não é json")).toThrow(ProjectParseError);
    expect(() => parseProject('{"app":"OutroApp","version":1,"clips":[]}')).toThrow(
      ProjectParseError,
    );
    expect(() => parseProject("null")).toThrow(ProjectParseError);
  });

  it("recusa projeto de versão FUTURA (não tenta adivinhar o formato)", () => {
    const doc = '{"app":"LocalVideo","version":99,"clips":[],"media":{}}';
    expect(() => parseProject(doc)).toThrow(/newer/);
  });

  it("recusa clipe corrompido em vez de abrir a timeline pela metade", () => {
    const bad = (c: string) => `{"app":"LocalVideo","version":1,"media":{},"clips":[${c}]}`;
    expect(() => parseProject(bad('{"id":"a","path":"","srcIn":0,"srcOut":10}'))).toThrow();
    expect(() => parseProject(bad('{"id":"a","path":"v.mp4","srcIn":10,"srcOut":10}'))).toThrow();
    expect(() => parseProject(bad('{"id":"a","path":"v.mp4","srcIn":0}'))).toThrow();
  });

  it("projeto vazio abre (é um projeto novo salvo, não um erro)", () => {
    expect(parseProject(serializeProject({ clips: [] }, {})).track.clips).toEqual([]);
  });
});
