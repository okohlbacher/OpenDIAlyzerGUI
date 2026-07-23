/**
 * The bulk tier: the peak facet, via parquet-wasm.
 *
 * This tier exists for correctness before performance. hyparquet cannot read
 * past the first data page of a DELTA_BINARY_PACKED column — measured cutoff
 * row 540,896 of 507,184,228 — and it fails *silently*, returning rows whose
 * struct is undefined. A silent wrong answer is worse than a slow one, so the
 * peak facet belongs here outright.
 *
 * parquet-wasm wants a Blob it can slice itself rather than a pull-based reader,
 * so `RangeBlob` presents exactly that surface over a `RangeReader`. Everything
 * still goes through the one interface, which is the point of having it.
 */
import { ParquetFile } from "parquet-wasm";
import { tableFromIPC } from "apache-arrow";
import type { RangeReader } from "./range.ts";
import type { MzPeakArchive } from "./archive.ts";
import { FACET } from "./archive.ts";
import type { MetadataIndex } from "./spectra.ts";
import { framesCovering } from "./spectra.ts";

/**
 * A Blob-like view over a `RangeReader`, for readers that slice rather than pull.
 *
 * Node's `openAsBlob` looks like the obvious shortcut here and works up to 4 GB,
 * then silently reports `size mod 2**32` — a 13.7 GB archive came back as
 * 801,746,959 bytes, and the truncated slice surfaced as "corrupt footer" from
 * deep inside WASM. diaPASEF archives are routinely 10 GB, so the shortcut was
 * wrong for the common case, not an edge case.
 *
 * Only what a Parquet reader touches is implemented: `size`, `slice`, and the
 * two byte accessors.
 */
export class RangeBlob {
  #reader: RangeReader;
  #offset: number;
  #length: number;

  constructor(reader: RangeReader, offset: number, length: number) {
    this.#reader = reader;
    this.#offset = offset;
    this.#length = length;
  }

  get size(): number {
    return this.#length;
  }
  get type(): string {
    return "application/octet-stream";
  }

  slice(start = 0, end = this.#length): RangeBlob {
    const lo = Math.min(Math.max(start < 0 ? this.#length + start : start, 0), this.#length);
    const hi = Math.min(Math.max(end < 0 ? this.#length + end : end, lo), this.#length);
    return new RangeBlob(this.#reader, this.#offset + lo, hi - lo);
  }

  async bytes(): Promise<Uint8Array> {
    return this.#reader.read(this.#offset, this.#length);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const b = await this.bytes();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  stream(): ReadableStream<Uint8Array> {
    const self = this;
    return new ReadableStream({
      async pull(c) {
        c.enqueue(await self.bytes());
        c.close();
      },
    });
  }
}

/** One decoded slice of the peak facet. Columnar — never per-row objects. */
export interface PeakColumns {
  readonly spectrumIndex: BigInt64Array;
  /** Raw TOF axis — timsTOF ims-compact archives. Empty when `mz` is present. */
  readonly tof: Int32Array;
  /** Direct m/z axis — Thermo and other non-ims-compact archives. */
  readonly mz: Float64Array | null;
  readonly intensity: Int32Array | Float32Array;
  readonly mobility: Float64Array | null;
  readonly rowCount: number;
  /** Absolute peak-facet row of element 0. */
  readonly firstRow: number;
}

export class PeakReader {
  #file: ParquetFile;
  #rowGroupFirstRow: number[];
  #rowGroupRows: number[];

  private constructor(file: ParquetFile, firstRow: number[], rows: number[]) {
    this.#file = file;
    this.#rowGroupFirstRow = firstRow;
    this.#rowGroupRows = rows;
  }

  static async open(a: MzPeakArchive): Promise<PeakReader> {
    const facet = await a.facet(FACET.spectraPeaks);
    const blob = new RangeBlob(facet, 0, facet.size);
    const file = await ParquetFile.fromFile(blob as unknown as File);
    const md = file.metadata();
    const firstRow: number[] = [];
    const rows: number[] = [];
    let acc = 0;
    for (let g = 0; g < md.numRowGroups(); g++) {
      const n = Number(md.rowGroup(g).numRows());
      firstRow.push(acc);
      rows.push(n);
      acc += n;
    }
    return new PeakReader(file, firstRow, rows);
  }

  get rowGroupCount(): number {
    return this.#rowGroupRows.length;
  }

  get totalRows(): number {
    const last = this.#rowGroupRows.length - 1;
    return last < 0 ? 0 : this.#rowGroupFirstRow[last]! + this.#rowGroupRows[last]!;
  }

  /** Row groups overlapping the absolute row range [from, to). */
  rowGroupsFor(from: number, to: number): number[] {
    const out: number[] = [];
    for (let g = 0; g < this.#rowGroupRows.length; g++) {
      const lo = this.#rowGroupFirstRow[g]!;
      const hi = lo + this.#rowGroupRows[g]!;
      if (hi > from && lo < to) out.push(g);
    }
    return out;
  }

  /**
   * Row groups holding any of the given row ranges — the union, not the span.
   *
   * Selected frames are interleaved with the other isolation windows of the
   * cycle, so the span between the first and last is far larger than the frames
   * themselves. On a dense diaPASEF run an 18-frame window spans 59 row groups
   * but only occupies about 20 of them; taking the span decodes three times the
   * data for the same answer.
   */
  rowGroupsForRanges(ranges: ReadonlyArray<readonly [number, number]>): number[] {
    const hit = new Set<number>();
    for (const [from, to] of ranges) for (const g of this.rowGroupsFor(from, to)) hit.add(g);
    return [...hit].sort((a, b) => a - b);
  }

  /** Rows in a row group. */
  rowsIn(group: number): number {
    return this.#rowGroupRows[group] ?? 0;
  }

  /**
   * Decodes row groups in bounded batches.
   *
   * One decode of everything is what a 4 GB wasm32 heap cannot survive: a dense
   * run at 211,000 peaks per frame turns a single chromatogram into 61 M rows,
   * roughly 1.4 GB of column data. Memory must be a function of the batch, not
   * of the experiment.
   */
  async *scan(groups: number[], maxRowsPerBatch = 2_000_000): AsyncGenerator<PeakColumns> {
    let batch: number[] = [];
    let rows = 0;
    for (const g of groups) {
      const n = this.rowsIn(g);
      if (batch.length && rows + n > maxRowsPerBatch) {
        yield await this.readRowGroups(batch);
        batch = [];
        rows = 0;
      }
      batch.push(g);
      rows += n;
    }
    if (batch.length) yield await this.readRowGroups(batch);
  }

  /**
   * Decodes whole row groups. Row groups are the finest unit available: the
   * entity-index column has exactly one page per row group, so a Parquet
   * RowSelection cannot narrow below one. 1,048,576 rows at a time, ~53 ms each.
   */
  async readRowGroups(groups: number[]): Promise<PeakColumns> {
    if (groups.length === 0) {
      return {
        spectrumIndex: new BigInt64Array(0),
        tof: new Int32Array(0),
        mz: null,
        intensity: new Int32Array(0),
        mobility: null,
        rowCount: 0,
        firstRow: 0,
      };
    }
    // Column projection would cut this decode from 24 bytes a row to 8, but it
    // is not usable: parquet-wasm emits a struct whose declared children do not
    // match the projected data, and Arrow JS's struct loader throws on it. The
    // same nested-struct limitation defeats hyparquet. Batch size is therefore
    // the only lever on memory, so it has to do the whole job.
    const wasm = await this.#file.read({ rowGroups: groups });
    const tbl = tableFromIPC(wasm.intoIPCStream());
    const point = tbl.getChild("point");
    if (!point) throw new Error("peak facet has no `point` column");

    // `toArray()` hands back the underlying typed array — zero-copy for a
    // single chunk, one concat otherwise. Never iterate with `.get(i)`: a
    // per-element call over a million rows is seconds, not milliseconds, and it
    // is precisely the JS object churn that makes naive Arrow readers unusable.
    const col = <T>(name: string): T | null => {
      const c = point.getChild(name);
      return c ? (c.toArray() as T) : null;
    };
    const spectrumIndex = col<BigInt64Array>("spectrum_index");
    const intensity = col<Int32Array | Float32Array>("intensity");
    if (!intensity) throw new Error("peak facet has no intensity column");
    // Thermo archives carry `mz` directly; timsTOF carries `tof` plus the
    // (a + b*tof)^2 transform. Expose whichever exists and let the caller
    // convert, since only it knows the calibration.
    const tof = col<Int32Array>("tof");
    const mz = col<Float64Array>("mz");

    return {
      spectrumIndex: spectrumIndex ?? new BigInt64Array(0),
      tof: tof ?? new Int32Array(0),
      mz: mz ?? null,
      intensity,
      mobility: col<Float64Array>("mean_inverse_reduced_ion_mobility"),
      rowCount: tbl.numRows,
      firstRow: this.#rowGroupFirstRow[groups[0]!]!,
    };
  }

  free(): void {
    this.#file.free();
  }
}

export interface XicRequest {
  /** Precursor m/z — selects which isolation windows, hence which MS2 frames. */
  precursorMz: number;
  /** RT bounds in minutes. Mandatory: unbounded costs 2.97 s and 1443 MB. */
  rtMin: number;
  rtMax: number;
  /** Fragment m/z values to trace. */
  fragments: number[];
  /** Mass tolerance in ppm. */
  ppm?: number;
}

export interface Xic {
  /** Retention time per point, one per contributing frame. */
  rt: Float64Array;
  /** One intensity trace per requested fragment, aligned to `rt`. */
  traces: Float64Array[];
  frames: number[];
  /** Rows parquet handed us — row-group quantisation, the unavoidable cost. */
  rowsDecoded: number;
  /** Rows we actually touched — what the offset table narrowed it to. */
  rowsScanned: number;
  rowGroupsRead: number;
}

/**
 * Extracts fragment chromatograms for one precursor.
 *
 * The whole design in five steps: isolation windows say which MS2 frames could
 * contain the fragments, the offset table says which rows those frames occupy,
 * the row groups covering them are decoded, m/z is reconstructed from the raw
 * axis, and matching intensities are summed per frame.
 *
 * The m/z mask is applied here rather than pushed down deliberately. The
 * upstream reader's m/z predicate is silently inert on timsTOF archives — a
 * physically impossible window returns the same data as a real one — so no
 * upstream m/z filter is ever trusted.
 */
export async function extractXic(
  a: MzPeakArchive,
  meta: MetadataIndex,
  reader: PeakReader,
  req: XicRequest,
): Promise<Xic> {
  const ppm = req.ppm ?? 20;
  const frames = framesCovering(meta, req.precursorMz, req.rtMin, req.rtMax);
  if (frames.length === 0) {
    return { rt: new Float64Array(0), traces: [], frames: [],
             rowsDecoded: 0, rowsScanned: 0, rowGroupsRead: 0 };
  }

  const { rowStart, time } = meta.spectra;
  const ranges = frames.map((f) => [rowStart[f]!, rowStart[f + 1]!] as const);
  const groups = reader.rowGroupsForRanges(ranges);

  const rt = new Float64Array(frames.length);
  frames.forEach((f, i) => (rt[i] = time[f]!));
  const traces = req.fragments.map(() => new Float64Array(frames.length));

  // Precompute tolerance windows once rather than per row.
  const lo = req.fragments.map((m) => m * (1 - ppm / 1e6));
  const hi = req.fragments.map((m) => m * (1 + ppm / 1e6));

  // Reconstruct m/z ourselves rather than trusting any upstream predicate:
  // the reference reader's m/z filter is silently inert on timsTOF archives.
  const cal = a.imsCalibration;
  const ca = cal?.a ?? 0;
  const cb = cal?.b ?? 0;
  const nF = lo.length;

  // Visit only the rows the offset table points at, one bounded batch at a time.
  //
  // Row groups are the finest unit parquet hands back, so the answer always
  // arrives inside a much larger decode. Testing every decoded row's spectrum
  // index — a BigInt64Array load plus a Map lookup — costs more than the decode
  // itself, and the offset table already knows the exact ranges.
  let matched = 0;
  let decoded = 0;

  for await (const cols of reader.scan(groups)) {
    decoded += cols.rowCount;
    const { tof, mz: mzCol, intensity } = cols;
    const useTof = mzCol === null;
    if (useTof && !cal) throw new Error("archive has neither an mz column nor ims_calibration");

    for (let k = 0; k < frames.length; k++) {
      const f = frames[k]!;
      const begin = rowStart[f]! - cols.firstRow;
      const end = rowStart[f + 1]! - cols.firstRow;
      if (end <= 0 || begin >= cols.rowCount) continue;
      const b = Math.max(0, begin);
      const e = Math.min(cols.rowCount, end);
      matched += e - b;

      for (let i = b; i < e; i++) {
        let mz: number;
        if (useTof) {
          const v = ca + cb * tof[i]!;
          mz = v * v;
        } else {
          mz = mzCol[i]!;
        }
        for (let g = 0; g < nF; g++) {
          if (mz >= lo[g]! && mz <= hi[g]!) {
            traces[g]![k] += intensity[i]!;
            break;
          }
        }
      }
    }
  }

  return {
    rt,
    traces,
    frames,
    rowsDecoded: decoded,
    rowsScanned: matched,
    rowGroupsRead: groups.length,
  };
}

export interface Coelution {
  /** Fragments with an apex clearly above their own baseline. */
  present: number;
  total: number;
  /** Of those, how many peak within a couple of frames of the strongest. */
  coeluting: number;
  /** Frame index of the strongest fragment's apex. */
  apex: number;
}

/**
 * How many fragments actually agree with each other.
 *
 * A single strong trace is not evidence of a peptide — it is the signature of
 * interference, one co-incident ion in a wide isolation window. What
 * distinguishes a real precursor is several fragments rising and falling
 * *together*. This returns the counts and lets the panel say what they support,
 * rather than asserting a conclusion the data does not carry.
 */
export function coelution(traces: readonly Float64Array[]): Coelution {
  const stats = traces.map((t) => {
    let max = 0, at = 0, sum = 0;
    for (let i = 0; i < t.length; i++) {
      sum += t[i]!;
      if (t[i]! > max) { max = t[i]!; at = i; }
    }
    const mean = t.length ? sum / t.length : 0;
    return { max, at, mean };
  });

  const strongest = stats.reduce((a, b) => (b.max > a.max ? b : a), { max: 0, at: 0, mean: 0 });
  // "Present" means the apex stands clearly above that trace's own average, so
  // a flat trace with a high baseline does not count.
  const present = stats.filter((s) => s.max > 0 && s.max > s.mean * 3);
  const coeluting = present.filter((s) => Math.abs(s.at - strongest.at) <= 2).length;
  return { present: present.length, total: traces.length, coeluting, apex: strongest.at };
}
