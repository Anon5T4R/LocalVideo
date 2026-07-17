/**
 * Tipos do mp4box.js.
 *
 * O pacote (0.5.4) não traz `.d.ts` nenhum. Isto NÃO é a API inteira dele — é
 * exatamente a fatia que o `lib/decoder.ts` usa, e nada mais. Declarar só o que
 * se usa é de propósito: um `any` global aqui apagaria a checagem justo na
 * fronteira mais escorregadia do app (a que lida com bytes de container), que é
 * onde os tipos mais valem.
 */
declare module "mp4box" {
  /** O mp4box exige saber o offset deste pedaço dentro do arquivo. */
  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }

  export interface MP4Track {
    id: number;
    /** String pronta pro WebCodecs, ex.: "avc1.64001f". */
    codec: string;
    nb_samples: number;
    track_width: number;
    track_height: number;
    timescale: number;
    video?: { width: number; height: number };
  }

  export interface MP4Info {
    videoTracks?: MP4Track[];
    audioTracks?: MP4Track[];
    duration: number;
    timescale: number;
  }

  export interface MP4Sample {
    /** Instante de apresentação, no timescale da trilha. */
    cts: number;
    /** Instante de decodificação (≠ cts quando há B-frames). */
    dts: number;
    duration: number;
    timescale: number;
    is_sync: boolean;
    data: Uint8Array;
  }

  export interface DataStreamCtor {
    new (buffer: ArrayBuffer | undefined, byteOffset: number, endianness: boolean): DataStream;
    BIG_ENDIAN: boolean;
    LITTLE_ENDIAN: boolean;
  }

  export interface DataStream {
    buffer: ArrayBuffer;
  }

  /** Uma entrada do stsd: carrega a caixa de config do codec. */
  export interface StsdEntry {
    avcC?: ConfigBox;
    hvcC?: ConfigBox;
    vpcC?: ConfigBox;
    av1C?: ConfigBox;
  }

  export interface ConfigBox {
    write(stream: DataStream): void;
  }

  export interface Trak {
    mdia?: { minf?: { stbl?: { stsd?: { entries: StsdEntry[] } } } };
  }

  export interface MP4File {
    onReady: (info: MP4Info) => void;
    onError: (e: unknown) => void;
    onSamples: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer(buf: MP4ArrayBuffer): number;
    flush(): void;
    start(): void;
    stop(): void;
    setExtractionOptions(id: number, user: unknown, opts: { nbSamples?: number }): void;
    getTrackById(id: number): Trak | undefined;
  }

  const MP4Box: {
    createFile(): MP4File;
    DataStream: DataStreamCtor;
  };
  export default MP4Box;
}
