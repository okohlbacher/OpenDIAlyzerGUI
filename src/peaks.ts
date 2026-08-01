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
  /**
   * Ion-mobility centre, in 1/K0. When given, peaks outside `imTolerance` of it
   * are excluded.
   *
   * Without this a co-eluting interferent at a different mobility contributes
   * its full intensity to the trace — which discards the separating dimension
   * diaPASEF exists to provide, and is exactly the interference the neighbouring
   * heat map makes visible.
   */
  imCenter?: number;
  /** Half-width in 1/K0. Default matches the ±0.05 typical of diaPASEF methods. */
  imTolerance?: number;
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
  /** Rows excluded by the ion-mobility window, when one was applied. */
  rowsOutsideIm: number;
  /** The mobility window used, for the panel to state. */
  imWindow: readonly [number, number] | null;
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
             rowsDecoded: 0, rowsScanned: 0, rowGroupsRead: 0,
             rowsOutsideIm: 0, imWindow: null };
  }

  const { rowStart, time } = meta.spectra;
  const ranges = frames.map((f) => [rowStart[f]!, rowStart[f + 1]!] as const);
  const groups = reader.rowGroupsForRanges(ranges);

  const rt = new Float64Array(frames.length);
  frames.forEach((f, i) => (rt[i] = time[f]!));
  const traces = req.fragments.map(() => new Float64Array(frames.length));

  const imTol = req.imTolerance ?? 0.05;
  const imLo = req.imCenter !== undefined ? req.imCenter - imTol : -Infinity;
  const imHi = req.imCenter !== undefined ? req.imCenter + imTol : Infinity;
  const imWindow = req.imCenter !== undefined
    ? ([imLo, imHi] as const) : null;
  let outsideIm = 0;

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
    const { tof, mz: mzCol, intensity, mobility } = cols;
    const useTof = mzCol === null;
    // An IM window was asked for but this archive has no mobility column —
    // apply nothing rather than silently dropping every peak.
    const useIm = imWindow !== null && mobility !== null;
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
        if (useIm) {
          const m = mobility![i]!;
          if (m < imLo || m > imHi) { outsideIm++; continue; }
        }
        let mz: number;
        if (useTof) {
          const v = ca + cb * tof[i]!;
          // A stale or malformed calibration can make this go negative for a
          // low-tof row; squaring would then silently produce a plausible but
          // wrong positive m/z instead of the impossible value it actually is.
          if (v <= 0) continue;
          mz = v * v;
        } else {
          mz = mzCol[i]!;
        }
        for (let g = 0; g < nF; g++) {
          if (mz >= lo[g]! && mz <= hi[g]!) {
            traces[g]![k] = traces[g]![k]! + intensity[i]!;
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
    rowsOutsideIm: outsideIm,
    imWindow,
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
 * How many fragments agree with each other.
 *
 * A single strong trace is weak evidence — one co-incident ion in a wide
 * isolation window looks the same. Several fragments rising and falling
 * together is stronger.
 *
 * **These are descriptive counts, not a test.** The thresholds below are
 * uncalibrated: `max > mean * 3` depends on how much baseline the window
 * happens to contain, and "within two frames" is a cycle count rather than a
 * chromatographic tolerance, so it means different things at different cycle
 * times. No error rate is attached. Callers must report the counts and let the
 * reader judge — an external review flagged the previous wording, which called
 * identifications and absences from these numbers, as unsupportable, and it
 * was right.
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

/** Monoisotopic residue masses, in Da. */
const AA: Record<string, number> = {
  G: 57.02146, A: 71.03711, S: 87.03203, P: 97.05276, V: 99.06841,
  T: 101.04768, C: 160.03065, L: 113.08406, I: 113.08406, N: 114.04293,
  D: 115.02694, Q: 128.05858, K: 128.09496, E: 129.04259, M: 131.04049,
  H: 137.05891, F: 147.06841, R: 156.10111, Y: 163.06333, W: 186.07931,
};
const H2O = 18.010565;
const PROTON = 1.007276;

export interface Fragment {
  /** Display label, e.g. `y7` or `y12²⁺`. */
  label: string;
  mz: number;
  series: "y";
  ordinal: number;
  charge: number;
}

/**
 * Chooses fragment ions worth extracting for a peptide.
 *
 * Two things make this more than a formula.
 *
 * **The acquired range is a hard limit.** A fragment above it returns a flat
 * trace indistinguishable from a real absence. A 23-mer's longest y-ions sit at
 * 1800–2386 Th against a diaPASEF acquisition ending at 1700, so asking for
 * "the first six y-ions" reported a confidently wrong "no signal" for a peptide
 * the engine had identified.
 *
 * **Fragment charge follows precursor charge.** A 3+ precursor yields plenty of
 * 2+ fragments, and for a long peptide those are often the only way to reach
 * the sequence-informative middle of the series while staying in range.
 *
 * Preference goes to the highest ordinals that fit, since those carry the most
 * sequence information; singly-charged wins a tie because it is the cleaner
 * measurement.
 */
export function fragmentsFor(
  sequence: string,
  precursorCharge: number,
  mzRange: readonly [number, number] = [0, Infinity],
  want = 6,
): Fragment[] {
  const [lo, hi] = mzRange;
  const maxCharge = Math.max(1, Math.min(2, precursorCharge - 1));
  const out: Fragment[] = [];

  let sum = H2O;
  for (let i = sequence.length - 1; i >= 1; i--) {
    const m = AA[sequence[i]!];
    if (m === undefined) break; // unknown residue — stop rather than guess
    sum += m;
    const ordinal = sequence.length - i;
    for (let z = 1; z <= maxCharge; z++) {
      const mz = (sum + z * PROTON) / z;
      if (mz < lo || mz > hi) continue;
      out.push({
        label: z === 1 ? `y${ordinal}` : `y${ordinal}${"²⁺"}`,
        mz, series: "y", ordinal, charge: z,
      });
    }
  }

  // y1 and y2 are shared by too many peptides to be diagnostic; drop them when
  // there is anything better to show.
  const useful = out.filter((f) => f.ordinal >= 3);
  const pool = useful.length >= want ? useful : out;
  return pool
    .sort((a, b) => b.ordinal - a.ordinal || a.charge - b.charge)
    .slice(0, want)
    .sort((a, b) => a.mz - b.mz);
}

export interface FramePeaks {
  mz: Float64Array;
  intensity: Float64Array;
  /** 1/K0, when the archive carries ion mobility. */
  mobility: Float64Array | null;
  /**
   * Which frame each peak came from, parallel to `mz`.
   *
   * The peaks of several frames arrive concatenated, so without this the
   * retention time of an individual peak is unrecoverable — which is exactly
   * what an RT × 1/K0 map needs. Spectrum and m/z × 1/K0 views ignore it.
   */
  frameOf: Int32Array;
  /** Frames actually read. */
  frames: number[];
  rowsScanned: number;
  rowsDecoded: number;
  rowGroupsRead: number;
}

/**
 * Reads the peaks of specific frames, m/z-reconstructed and optionally masked.
 *
 * Both new viewers are this same read: a spectrum is one frame's peaks plotted
 * against m/z, and an ion-mobility heat map is the same points binned over
 * (m/z, 1/K0). Extracting once and letting the caller shape it avoids two
 * near-identical passes over 3.7 billion peaks.
 *
 * As everywhere, m/z is reconstructed here rather than pushed down: the
 * reference reader's m/z predicate is silently inert on timsTOF archives.
 */
export async function extractFramePeaks(
  a: MzPeakArchive,
  meta: MetadataIndex,
  reader: PeakReader,
  frames: readonly number[],
  mzRange?: readonly [number, number],
): Promise<FramePeaks> {
  const empty: FramePeaks = {
    mz: new Float64Array(0), intensity: new Float64Array(0), mobility: null,
    frameOf: new Int32Array(0),
    frames: [...frames], rowsScanned: 0, rowsDecoded: 0, rowGroupsRead: 0,
  };
  if (!frames.length) return empty;

  const { rowStart } = meta.spectra;
  const ranges = frames.map((f) => [rowStart[f]!, rowStart[f + 1]!] as const);
  const groups = reader.rowGroupsForRanges(ranges);

  const cal = a.imsCalibration;
  const lo = mzRange?.[0] ?? -Infinity;
  const hi = mzRange?.[1] ?? Infinity;

  const outMz: number[] = [];
  const outInt: number[] = [];
  const outMob: number[] = [];
  const outFrame: number[] = [];
  let decoded = 0;
  let scanned = 0;

  for await (const cols of reader.scan(groups)) {
    decoded += cols.rowCount;
    const { tof, mz: mzCol, intensity, mobility } = cols;
    const useTof = mzCol === null;
    if (useTof && !cal) throw new Error("archive has neither an mz column nor ims_calibration");
    const ca = cal?.a ?? 0;
    const cb = cal?.b ?? 0;

    for (const f of frames) {
      const begin = rowStart[f]! - cols.firstRow;
      const end = rowStart[f + 1]! - cols.firstRow;
      if (end <= 0 || begin >= cols.rowCount) continue;
      const b = Math.max(0, begin);
      const e = Math.min(cols.rowCount, end);
      scanned += e - b;
      for (let i = b; i < e; i++) {
        let m: number;
        // See extractXic: a negative calibrated value must not be squared into
        // a spurious positive m/z that could pass the window check below.
        if (useTof) {
          const v = ca + cb * tof[i]!;
          if (v <= 0) continue;
          m = v * v;
        } else {
          m = mzCol[i]!;
        }
        if (m < lo || m > hi) continue;
        outMz.push(m);
        outInt.push(intensity[i]!);
        outFrame.push(f);
        if (mobility) outMob.push(mobility[i]!);
      }
    }
  }

  return {
    mz: Float64Array.from(outMz),
    intensity: Float64Array.from(outInt),
    mobility: outMob.length ? Float64Array.from(outMob) : null,
    frameOf: Int32Array.from(outFrame),
    frames: [...frames],
    rowsScanned: scanned,
    rowsDecoded: decoded,
    rowGroupsRead: groups.length,
  };
}

export interface Heatmap {
  /** Column-major bins, `nx * ny`, already log-scaled to [0,1]. */
  cells: Float32Array;
  nx: number;
  ny: number;
  mzRange: [number, number];
  mobilityRange: [number, number];
  /** Marginal over m/z — the mobilogram, one value per y bin, scaled to [0,1]. */
  mobilogram: Float32Array;
  maxIntensity: number;
}

/**
 * Bins peaks into an m/z × 1/K0 heat map plus its mobility marginal.
 *
 * Binning happens here rather than in the renderer so the IPC payload is a
 * fixed-size grid instead of millions of points — a frame of diaPASEF data is
 * ~200,000 peaks, and shipping those to the UI to bin would dominate the cost.
 *
 * The mobilogram is the row sum, which is what Skyline draws beside its heat map
 * with the intensity axis reversed so zero touches the map.
 */
export function heatmap(
  p: FramePeaks,
  nx = 220,
  ny = 120,
  mzRange?: readonly [number, number],
): Heatmap | null {
  if (!p.mobility || !p.mz.length) return null;

  let mzLo = mzRange?.[0] ?? Infinity;
  let mzHi = mzRange?.[1] ?? -Infinity;
  let imLo = Infinity;
  let imHi = -Infinity;
  for (let i = 0; i < p.mz.length; i++) {
    if (!mzRange) { if (p.mz[i]! < mzLo) mzLo = p.mz[i]!; if (p.mz[i]! > mzHi) mzHi = p.mz[i]!; }
    const m = p.mobility[i]!;
    if (m < imLo) imLo = m;
    if (m > imHi) imHi = m;
  }
  if (!(mzHi > mzLo) || !(imHi > imLo)) return null;

  const cells = new Float32Array(nx * ny);
  const marg = new Float32Array(ny);
  const sx = nx / (mzHi - mzLo);
  const sy = ny / (imHi - imLo);
  let max = 0;

  for (let i = 0; i < p.mz.length; i++) {
    const m = p.mz[i]!;
    if (m < mzLo || m > mzHi) continue;
    const x = Math.min(nx - 1, Math.max(0, ((m - mzLo) * sx) | 0));
    const y = Math.min(ny - 1, Math.max(0, ((p.mobility[i]! - imLo) * sy) | 0));
    const v = p.intensity[i]!;
    const k = x * ny + y;
    cells[k]! += v;
    marg[y]! += v;
    if (cells[k]! > max) max = cells[k]!;
  }

  // Log scaling: DIA intensities span several orders of magnitude, so a linear
  // ramp shows the base peak and nothing else.
  const norm = max > 0 ? 1 / Math.log1p(max) : 0;
  for (let i = 0; i < cells.length; i++) cells[i] = Math.log1p(cells[i]!) * norm;
  let mMax = 0;
  for (const v of marg) if (v > mMax) mMax = v;
  if (mMax > 0) for (let i = 0; i < marg.length; i++) marg[i]! /= mMax;

  return {
    cells, nx, ny,
    mzRange: [mzLo, mzHi],
    mobilityRange: [imLo, imHi],
    mobilogram: marg,
    maxIntensity: max,
  };
}

/** The expected coordinates of an identification, in RT (min) and 1/K0. */
export interface RtImBox {
  rtMin: number;
  rtMax: number;
  imMin: number;
  imMax: number;
}

export interface RtMobilityMap {
  /** Column-major bins, `nx * ny`, log-scaled to [0,1]. */
  cells: Float32Array;
  nx: number;
  ny: number;
  rtRange: [number, number];
  mobilityRange: [number, number];
  /** Largest single bin, unscaled — so the panel can state absolute numbers. */
  maxIntensity: number;
  /** Every binned intensity, unscaled. */
  total: number;
  /** Intensity inside `box`, and outside it. Zero for both when no box given. */
  inBox: number;
  outBox: number;
}

/**
 * Bins one m/z window's peaks over (retention time × 1/K0).
 *
 * This is the tile of the per-fragment grid, and it differs from `heatmap()` in
 * exactly one respect — the x axis is retention time rather than m/z. That one
 * difference is what turns a snapshot of a frame into evidence about elution.
 *
 * Both ranges are **required rather than derived from the data**, for two
 * reasons. Small multiples are only comparable when every tile shares its axes.
 * And a tile with no peaks at all still has to render — an empty tile inside a
 * drawn expectation box is the finding, not an error — which is impossible if
 * the extent comes from points that are not there.
 *
 * `inBox`/`outBox` are the absence-evidence counters. A fragment tile carrying
 * plenty of intensity, all of it outside the box, is the case that refutes an
 * identification, and it is indistinguishable from a genuine hit unless the
 * split is measured rather than eyeballed.
 *
 * Returns `null` only when the archive carries no mobility at all, matching
 * `heatmap()`. That is structurally different from "no signal here", which is a
 * valid all-zero map.
 */
export function rtMobilityMap(
  p: FramePeaks,
  frameTime: Float64Array | readonly number[],
  opts: {
    rtRange: readonly [number, number];
    mobilityRange: readonly [number, number];
    nx?: number;
    ny?: number;
    box?: RtImBox;
  },
): RtMobilityMap | null {
  if (!p.mobility) return null;

  const nx = opts.nx ?? 120;
  const ny = opts.ny ?? 90;
  const [rtLo, rtHi] = opts.rtRange;
  const [imLo, imHi] = opts.mobilityRange;
  if (!(rtHi > rtLo) || !(imHi > imLo)) return null;

  const cells = new Float32Array(nx * ny);
  const sx = nx / (rtHi - rtLo);
  const sy = ny / (imHi - imLo);
  const box = opts.box;
  let max = 0;
  let total = 0;
  let inBox = 0;
  let outBox = 0;

  for (let i = 0; i < p.mz.length; i++) {
    const rt = frameTime[p.frameOf[i]!];
    if (rt === undefined) continue;
    const im = p.mobility[i]!;
    // Explicit, because every NaN comparison is false: an unguarded NaN would
    // survive the range test and then bin at `(NaN|0) === 0`, quietly stacking
    // mobility-less peaks into the bottom row.
    if (!Number.isFinite(im)) continue;
    if (rt < rtLo || rt > rtHi || im < imLo || im > imHi) continue;
    const v = p.intensity[i]!;

    // Clamping keeps a point sitting exactly on the upper bound in the last
    // bin instead of one past the end of the row.
    const x = Math.min(nx - 1, Math.max(0, ((rt - rtLo) * sx) | 0));
    const y = Math.min(ny - 1, Math.max(0, ((im - imLo) * sy) | 0));
    const k = x * ny + y;
    cells[k]! += v;
    total += v;
    if (cells[k]! > max) max = cells[k]!;

    if (box) {
      if (rt >= box.rtMin && rt <= box.rtMax && im >= box.imMin && im <= box.imMax) inBox += v;
      else outBox += v;
    }
  }

  // Log scaling, as in `heatmap()`: DIA intensities span orders of magnitude, so
  // a linear ramp shows the base peak and nothing else. `maxIntensity` is kept
  // unscaled so the caller never has to invert this to quote a real number.
  const norm = max > 0 ? 1 / Math.log1p(max) : 0;
  for (let i = 0; i < cells.length; i++) cells[i] = Math.log1p(cells[i]!) * norm;

  return {
    cells, nx, ny,
    rtRange: [rtLo, rtHi],
    mobilityRange: [imLo, imHi],
    maxIntensity: max,
    total,
    inBox,
    outBox,
  };
}

/** One tile of the evidence grid: a labelled m/z to trace. */
export interface TileRequest {
  label: string;
  mz: number;
  /** Overrides the request-wide default when a tile needs its own tolerance. */
  ppm?: number;
}

export interface Tile extends TileRequest {
  /** Null only when the archive carries no mobility. */
  map: RtMobilityMap | null;
}

export interface TileGrid {
  tiles: Tile[];
  rowsDecoded: number;
  rowsScanned: number;
  rowGroupsRead: number;
  /** Peaks kept by any window — the fraction of the decode that was useful. */
  peaksKept: number;
}

/**
 * Bins many m/z windows over one shared (RT × 1/K0) extent, in a single pass.
 *
 * The obvious implementation — call `extractFramePeaks` once per fragment — is
 * N+1 decodes of the *same* row groups, because every tile of a grid covers the
 * same frames and differs only in its m/z mask. Row-group decode dominates the
 * cost of a bounded query, so paying it per tile turns a 12-fragment grid into
 * thirteen times the work for no extra information. This decodes once and tests
 * each peak against every window, which is a handful of float comparisons
 * against a cost measured in megabytes.
 *
 * Every tile shares `rtRange` and `mobilityRange`, which is what makes the
 * result a small-multiple grid rather than twelve unrelated pictures: tiles are
 * only comparable when their axes are identical. `box` is passed through to
 * each tile so absence can be counted per fragment.
 */
export async function extractTiles(
  a: MzPeakArchive,
  meta: MetadataIndex,
  reader: PeakReader,
  frames: readonly number[],
  requests: readonly TileRequest[],
  opts: {
    rtRange: readonly [number, number];
    mobilityRange: readonly [number, number];
    ppm?: number;
    nx?: number;
    ny?: number;
    box?: RtImBox;
  },
): Promise<TileGrid> {
  const defaultPpm = opts.ppm ?? 20;
  const lo = requests.map((t) => t.mz - (t.mz * (t.ppm ?? defaultPpm)) / 1e6);
  const hi = requests.map((t) => t.mz + (t.mz * (t.ppm ?? defaultPpm)) / 1e6);

  // Per-tile accumulators. Only matching peaks are retained, and a ppm window
  // keeps that to a few thousand even on a dense frame.
  const mzs: number[][] = requests.map(() => []);
  const ints: number[][] = requests.map(() => []);
  const mobs: number[][] = requests.map(() => []);
  const frameOfs: number[][] = requests.map(() => []);

  let decoded = 0, scanned = 0, kept = 0, groupsRead = 0;
  let sawMobility = false;

  if (frames.length) {
    const { rowStart } = meta.spectra;
    const ranges = frames.map((f) => [rowStart[f]!, rowStart[f + 1]!] as const);
    const groups = reader.rowGroupsForRanges(ranges);
    groupsRead = groups.length;
    const cal = a.imsCalibration;

    for await (const cols of reader.scan(groups)) {
      decoded += cols.rowCount;
      const { tof, mz: mzCol, intensity, mobility } = cols;
      if (mobility) sawMobility = true;
      const useTof = mzCol === null;
      if (useTof && !cal) throw new Error("archive has neither an mz column nor ims_calibration");
      const ca = cal?.a ?? 0;
      const cb = cal?.b ?? 0;

      for (const f of frames) {
        const begin = rowStart[f]! - cols.firstRow;
        const end = rowStart[f + 1]! - cols.firstRow;
        if (end <= 0 || begin >= cols.rowCount) continue;
        const b = Math.max(0, begin);
        const e = Math.min(cols.rowCount, end);
        scanned += e - b;
        for (let i = b; i < e; i++) {
          let m: number;
          // As elsewhere: a negative calibrated value must not be squared into a
          // spurious positive m/z that could pass a window check.
          if (useTof) {
            const v = ca + cb * tof[i]!;
            if (v <= 0) continue;
            m = v * v;
          } else {
            m = mzCol[i]!;
          }
          // Every matching window, not the first. Tolerance windows overlap on
          // real data — measured at 0.6% of identifications, and the usual case
          // is a fragment landing on the precursor's own m/z. Stopping at the
          // first match would let whichever tile is listed earlier silently
          // consume the peak, and since the precursor is always tile zero, that
          // is a systematic bias against fragments rather than a coin flip.
          let hit = false;
          for (let t = 0; t < requests.length; t++) {
            if (m < lo[t]! || m > hi[t]!) continue;
            mzs[t]!.push(m);
            ints[t]!.push(intensity[i]!);
            frameOfs[t]!.push(f);
            // NaN keeps the mobility column aligned with the others when a
            // batch carries none; rtMobilityMap drops non-finite values rather
            // than binning them into the first row.
            mobs[t]!.push(mobility ? mobility[i]! : NaN);
            hit = true;
          }
          if (hit) kept++;
        }
      }
    }
  }

  const tiles: Tile[] = requests.map((req, t) => {
    const fp: FramePeaks = {
      mz: Float64Array.from(mzs[t]!),
      intensity: Float64Array.from(ints[t]!),
      // An empty tile in a mobility-bearing archive must still bin, so the
      // capability is taken from the decode, not from whether this tile matched.
      mobility: sawMobility ? Float64Array.from(mobs[t]!) : null,
      frameOf: Int32Array.from(frameOfs[t]!),
      frames: [...frames],
      rowsScanned: 0, rowsDecoded: 0, rowGroupsRead: 0,
    };
    return { ...req, map: rtMobilityMap(fp, meta.spectra.time, opts) };
  });

  return { tiles, rowsDecoded: decoded, rowsScanned: scanned, rowGroupsRead: groupsRead, peaksKept: kept };
}

export interface CorrelationMatrix {
  /** Row-major `n × n` Pearson coefficients in [-1,1]. */
  r: Float32Array;
  n: number;
}

/**
 * Pairwise Pearson correlation between fragment traces.
 *
 * Substrate for the co-elution matrix: a coherent block is a peptide, an
 * off-diagonal block is an interferent following its own elution profile. No
 * published figure does this — see `docs/VIZ-PLAN.md` — so it reports numbers
 * and attaches no verdict, deliberately unlike `coelution()`, whose own
 * docstring warns its thresholds are uncalibrated.
 *
 * A trace with no variance — flat, or entirely absent — correlates with nothing.
 * Pearson is undefined there (a zero denominator), and this returns 0 rather
 * than `NaN` so one dead fragment cannot poison the matrix. Its diagonal is 0
 * too, not 1: a blank row for a fragment that contributed nothing is the honest
 * reading, where a unit diagonal would draw the eye to a self-similarity that
 * carries no information.
 */
export function correlationMatrix(traces: readonly Float64Array[]): CorrelationMatrix {
  const n = traces.length;
  const r = new Float32Array(n * n);
  if (n === 0) return { r, n };

  // Every statistic is computed over the same prefix. Taking the mean and the
  // norm from each full trace while summing covariance over a shorter overlap
  // mixes two different populations, and the result is not a correlation — a
  // trace does not even reach 1 against itself.
  let len = Infinity;
  for (const t of traces) len = Math.min(len, t.length);
  if (!Number.isFinite(len)) len = 0;

  const mean = new Float64Array(n);
  const sd = new Float64Array(n);
  for (let a = 0; a < n; a++) {
    const t = traces[a]!;
    let s = 0;
    for (let i = 0; i < len; i++) s += t[i]!;
    const m = len ? s / len : 0;
    let q = 0;
    for (let i = 0; i < len; i++) { const d = t[i]! - m; q += d * d; }
    mean[a] = m;
    sd[a] = Math.sqrt(q);
  }

  for (let a = 0; a < n; a++) {
    if (sd[a] === 0) continue;                 // dead trace: whole row stays 0
    for (let b = a; b < n; b++) {
      if (sd[b] === 0) continue;
      const ta = traces[a]!, tb = traces[b]!;
      let cov = 0;
      for (let i = 0; i < len; i++) cov += (ta[i]! - mean[a]!) * (tb[i]! - mean[b]!);
      const v = cov / (sd[a]! * sd[b]!);
      const c = v > 1 ? 1 : v < -1 ? -1 : v;   // guard float drift past ±1
      r[a * n + b] = c;
      r[b * n + a] = c;
    }
  }
  return { r, n };
}

/**
 * Centroids a frame's peaks into a spectrum, keeping the strongest.
 *
 * A diaPASEF frame is the whole mobility ramp, so the same fragment appears at
 * many 1/K0 values; summing over mobility is what turns it back into a spectrum.
 */
export function spectrum(p: FramePeaks, tolerancePpm = 15, keep = 400):
    { mz: Float64Array; intensity: Float64Array; total: number } {
  if (!p.mz.length) {
    return { mz: new Float64Array(0), intensity: new Float64Array(0), total: 0 };
  }

  const order = Array.from(p.mz.keys()).sort((a, b) => p.mz[a]! - p.mz[b]!);
  const mz: number[] = [];
  const inten: number[] = [];
  let curMz = p.mz[order[0]!]!;
  let curW = 0;
  let curI = 0;

  const flush = () => { if (curI > 0) { mz.push(curW / curI); inten.push(curI); } };
  for (const i of order) {
    const m = p.mz[i]!;
    if (curI > 0 && (m - curMz) / curMz * 1e6 > tolerancePpm) {
      flush();
      curW = 0; curI = 0;
    }
    if (curI === 0) curMz = m;
    curW += m * p.intensity[i]!;
    curI += p.intensity[i]!;
  }
  flush();

  // Keep the strongest, then restore m/z order for drawing.
  const idx = Array.from(inten.keys()).sort((a, b) => inten[b]! - inten[a]!).slice(0, keep);
  idx.sort((a, b) => mz[a]! - mz[b]!);
  return {
    mz: Float64Array.from(idx, (i) => mz[i]!),
    intensity: Float64Array.from(idx, (i) => inten[i]!),
    total: inten.length,
  };
}
