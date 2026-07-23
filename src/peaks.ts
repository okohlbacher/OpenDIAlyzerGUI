/**
 * The bulk tier: the peak facet, via parquet-wasm.
 *
 * This tier exists for correctness before performance. hyparquet cannot read
 * past the first data page of a DELTA_BINARY_PACKED column — measured cutoff
 * row 540,896 of 507,184,228 — and it fails *silently*, returning rows whose
 * struct is undefined. A silent wrong answer is worse than a slow one, so the
 * peak facet belongs here outright.
 *
 * parquet-wasm takes a Blob and slices it itself, so the archive hands it a
 * lazily-backed slice rather than bytes. `openAsBlob` keeps that lazy on disk;
 * in a browser a File from a picker or a Response body plays the same role.
 */
import { ParquetFile } from "parquet-wasm";
import { openAsBlob } from "node:fs";
import { tableFromIPC } from "apache-arrow";
import type { MzPeakArchive } from "./archive.ts";
import { FACET } from "./archive.ts";
import type { MetadataIndex } from "./spectra.ts";
import { framesCovering } from "./spectra.ts";

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
    const { path, start, size } = await a.memberRange(FACET.spectraPeaks);
    const blob = (await openAsBlob(path)).slice(start, start + size);
    const file = await ParquetFile.fromFile(blob);
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
    if (!spectrumIndex || !intensity) {
      throw new Error("peak facet missing spectrum_index/intensity");
    }
    // Thermo archives carry `mz` directly; timsTOF carries `tof` plus the
    // (a + b*tof)^2 transform. Expose whichever exists and let the caller
    // convert, since only it knows the calibration.
    const tof = col<Int32Array>("tof");
    const mz = col<Float64Array>("mz");

    return {
      spectrumIndex,
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
  const from = rowStart[frames[0]!]!;
  const to = rowStart[frames.at(-1)! + 1]!;
  const groups = reader.rowGroupsFor(from, to);
  const cols = await reader.readRowGroups(groups);

  const rt = new Float64Array(frames.length);
  frames.forEach((f, i) => (rt[i] = time[f]!));
  const traces = req.fragments.map(() => new Float64Array(frames.length));

  // Precompute tolerance windows once rather than per row.
  const lo = req.fragments.map((m) => m * (1 - ppm / 1e6));
  const hi = req.fragments.map((m) => m * (1 + ppm / 1e6));

  // Reconstruct m/z ourselves rather than trusting any upstream predicate:
  // the reference reader's m/z filter is silently inert on timsTOF archives.
  const cal = a.imsCalibration;
  const { tof, mz: mzCol, intensity } = cols;
  const useTof = mzCol === null;
  if (useTof && !cal) throw new Error("archive has neither an mz column nor ims_calibration");
  const ca = cal?.a ?? 0;
  const cb = cal?.b ?? 0;
  const nF = lo.length;

  // Visit only the rows the offset table points at.
  //
  // Row groups are the finest unit parquet can hand back, so a 105k-row answer
  // arrives inside ~3 M decoded rows. Testing each of those rows' spectrum
  // index — a BigInt64Array load plus a Map lookup — costs more than the decode
  // itself. The offset table already knows the exact row ranges, so iterate
  // those and touch nothing else.
  let matched = 0;
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

  return {
    rt,
    traces,
    frames,
    rowsDecoded: cols.rowCount,
    rowsScanned: matched,
    rowGroupsRead: groups.length,
  };
}
