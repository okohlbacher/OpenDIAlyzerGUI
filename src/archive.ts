/**
 * An open .mzpeak archive: members, the JSON index, and a RangeReader per facet.
 *
 * Also accepts an unpacked directory, which the reference implementation
 * supports (DirectorySource, archive/sync.rs:808-886) and which makes debugging
 * much easier.
 */
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { FileRangeReader, SliceRangeReader, type RangeReader } from "./range.ts";
import { readCentralDirectory, resolveDataOffset, STORED, type ZipMember } from "./zip.ts";

/** Canonical member names — vendor/mzpeak_prototyping/src/constants.rs:14-22 */
export const FACET = {
  spectraData: "spectra_data.parquet",
  spectraPeaks: "spectra_peaks.parquet",
  spectraMetadata: "spectra_metadata.parquet",
  chromatogramsData: "chromatograms_data.parquet",
  chromatogramsMetadata: "chromatograms_metadata.parquet",
  index: "mzpeak_index.json",
} as const;

export interface IndexEntry {
  name: string;
  entity_type?: string;
  data_kind?: string;
}

export interface ImsCalibration {
  a: number;
  b: number;
  codec?: string;
  /** m/z = (a + b*tof)^2 — the transform the upstream m/z filter forgets about. */
  mz_from_tof?: string;
  tof_encoding?: "absolute" | "per-scan-delta" | "m/z-chunked";
}

export interface MzPeakIndex {
  files: IndexEntry[];
  metadata?: Record<string, unknown> & { ims_calibration?: ImsCalibration; version?: string };
}

export class MzPeakArchive {
  readonly source: string;
  readonly index: MzPeakIndex;
  #reader: RangeReader | null;
  #members: Map<string, ZipMember>;
  #dirFiles: Map<string, string> | null;

  private constructor(
    source: string,
    reader: RangeReader | null,
    members: Map<string, ZipMember>,
    dirFiles: Map<string, string> | null,
    index: MzPeakIndex,
  ) {
    this.source = source;
    this.#reader = reader;
    this.#members = members;
    this.#dirFiles = dirFiles;
    this.index = index;
  }

  static async open(path: string): Promise<MzPeakArchive> {
    const st = await stat(path);
    return st.isDirectory() ? MzPeakArchive.#openDir(path) : MzPeakArchive.#openZip(path);
  }

  static async #openZip(path: string): Promise<MzPeakArchive> {
    const reader = await FileRangeReader.open(path);
    const members = new Map<string, ZipMember>();
    for (const m of await readCentralDirectory(reader)) members.set(m.name, m);

    const idx = members.get(FACET.index);
    if (!idx) throw new Error(`${basename(path)}: not an mzPeak archive (no ${FACET.index})`);
    const off = await resolveDataOffset(reader, idx);
    const raw = await reader.read(off, idx.compressedSize);
    if (idx.method !== STORED) {
      throw new Error(`${FACET.index} is compressed (method ${idx.method}); expected STORED`);
    }
    const index = JSON.parse(new TextDecoder().decode(raw)) as MzPeakIndex;
    return new MzPeakArchive(path, reader, members, null, index);
  }

  static async #openDir(path: string): Promise<MzPeakArchive> {
    const files = new Map<string, string>();
    for (const name of await readdir(path)) files.set(name, join(path, name));
    const idxPath = files.get(FACET.index);
    if (!idxPath) throw new Error(`${basename(path)}: no ${FACET.index}`);
    const r = await FileRangeReader.open(idxPath);
    const raw = await r.read(0, r.size);
    await r.close();
    const index = JSON.parse(new TextDecoder().decode(raw)) as MzPeakIndex;
    return new MzPeakArchive(path, null, new Map(), files, index);
  }

  /** Member names present in the container, in directory order. */
  get memberNames(): string[] {
    return this.#dirFiles ? [...this.#dirFiles.keys()] : [...this.#members.keys()];
  }

  has(name: string): boolean {
    return this.#dirFiles ? this.#dirFiles.has(name) : this.#members.has(name);
  }

  /**
   * A RangeReader over one facet, as if it were a standalone file.
   * No bytes are read here beyond the local header.
   */
  async facet(name: string): Promise<RangeReader> {
    if (this.#dirFiles) {
      const p = this.#dirFiles.get(name);
      if (!p) throw new Error(`no member ${name}`);
      return FileRangeReader.open(p);
    }
    const m = this.#members.get(name);
    if (!m) throw new Error(`no member ${name}`);
    if (m.method !== STORED) {
      // Vendor side-files are gzipped; facets never are. Refusing loudly beats
      // handing a Parquet reader compressed bytes.
      throw new Error(`member ${name} is compressed (method ${m.method}); expected STORED`);
    }
    const off = await resolveDataOffset(this.#reader!, m);
    return new SliceRangeReader(this.#reader!, off, m.compressedSize);
  }

  /**
   * A member's absolute byte range in the container.
   *
   * The bulk tier needs this: WASM Parquet readers want a Blob-like source they
   * can slice themselves rather than a pull-based reader.
   */
  async memberRange(name: string): Promise<{ path: string; start: number; size: number }> {
    if (this.#dirFiles) {
      const p = this.#dirFiles.get(name);
      if (!p) throw new Error(`no member ${name}`);
      const { size } = await stat(p);
      return { path: p, start: 0, size };
    }
    const m = this.#members.get(name);
    if (!m) throw new Error(`no member ${name}`);
    if (m.method !== STORED) throw new Error(`member ${name} is compressed`);
    const start = await resolveDataOffset(this.#reader!, m);
    return { path: this.source, start, size: m.compressedSize };
  }

  /** TOF → m/z parameters, when this is a timsTOF ims-compact archive. */
  get imsCalibration(): ImsCalibration | undefined {
    return this.index.metadata?.ims_calibration;
  }

  /**
   * m/z from a raw TOF index. timsTOF ims-compact archives have no m/z column;
   * the upstream reader's m/z filter is silently inert on them (verified: a
   * physically impossible window returns the same data), so every m/z mask we
   * apply must go through this.
   */
  mzFromTof(tof: number): number {
    const c = this.imsCalibration;
    if (!c) throw new Error("no ims_calibration in this archive");
    const v = c.a + c.b * tof;
    return v * v;
  }

  async close(): Promise<void> {
    await this.#reader?.close?.();
  }
}
