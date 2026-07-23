/**
 * The one interface that knows what a file is.
 *
 * Everything above this sees byte ranges and nothing else — no paths, no URLs,
 * no filesystem. That is what makes the cloud backend (docs/ROADMAP.md phase 5)
 * a second implementation rather than a rewrite.
 */
export interface RangeReader {
  readonly size: number;
  /** Bytes [offset, offset+length). Short reads are an error, not a partial result. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

import { open, type FileHandle } from "node:fs/promises";

export class FileRangeReader implements RangeReader {
  readonly size: number;
  #fh: FileHandle;

  private constructor(fh: FileHandle, size: number) {
    this.#fh = fh;
    this.size = size;
  }

  static async open(path: string): Promise<FileRangeReader> {
    const fh = await open(path, "r");
    const { size } = await fh.stat();
    return new FileRangeReader(fh, size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new RangeError(
        `read ${offset}+${length} outside file of ${this.size} bytes`,
      );
    }
    const buf = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await this.#fh.read(buf, got, length - got, offset + got);
      if (bytesRead === 0) throw new Error(`short read at ${offset + got}`);
      got += bytesRead;
    }
    return buf;
  }

  async close(): Promise<void> {
    await this.#fh.close();
  }
}

/**
 * Wraps a RangeReader to expose a sub-range as if it were a whole file.
 * This is how a Parquet facet inside the archive is handed to a Parquet reader
 * without extracting it.
 */
export class SliceRangeReader implements RangeReader {
  readonly size: number;
  #inner: RangeReader;
  #start: number;

  constructor(inner: RangeReader, start: number, size: number) {
    this.#inner = inner;
    this.#start = start;
    this.size = size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new RangeError(
        `read ${offset}+${length} outside slice of ${this.size} bytes`,
      );
    }
    return this.#inner.read(this.#start + offset, length);
  }
}

/**
 * Counts reads and bytes. Used by tests to assert that a query pruned row
 * groups instead of scanning — the difference between 105 ms and 2.97 s.
 */
export class CountingRangeReader implements RangeReader {
  reads = 0;
  bytes = 0;
  #inner: RangeReader;

  constructor(inner: RangeReader) {
    this.#inner = inner;
  }
  get size(): number {
    return this.#inner.size;
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    this.reads++;
    this.bytes += length;
    return this.#inner.read(offset, length);
  }
  reset() {
    this.reads = 0;
    this.bytes = 0;
  }
}
