/**
 * The report table — DIA-NN's `report.parquet`, and OpenDIAlyzer's own output,
 * which writes the same logical table.
 *
 * One loader, one table model. The engine is a provenance badge, not a code
 * path. That only works if the loader is genuinely tolerant: DIA-NN adds
 * columns every release and gates some behind Enterprise, so anything
 * unrecognised is carried through rather than rejected, and anything absent is
 * absent rather than fatal.
 *
 * Deliberately *not* read: `report.pg_matrix.tsv` and friends. They disagree
 * with the report they were derived from — DIA-NN #1056 needed three rounds
 * with the author to reconstruct the filter, and the answer included an
 * undocumented 0.05 threshold and a non-zero-quantity predicate. Two sources of
 * truth is the bug; we derive protein-level numbers from the report itself.
 */
import { ParquetFile } from "parquet-wasm";
import { FileRangeReader } from "./range.ts";
import { RangeBlob } from "./peaks.ts";
import { tableFromIPC, type Table, type Vector } from "apache-arrow";

/** Columns the UI depends on, and the names it knows them by. */
export const CANONICAL = {
  run: "Run",
  runIndex: "Run.Index",
  precursorId: "Precursor.Id",
  modifiedSequence: "Modified.Sequence",
  strippedSequence: "Stripped.Sequence",
  charge: "Precursor.Charge",
  precursorMz: "Precursor.Mz",
  decoy: "Decoy",
  proteotypic: "Proteotypic",

  proteinGroup: "Protein.Group",
  proteinIds: "Protein.Ids",
  proteinNames: "Protein.Names",
  genes: "Genes",

  // The seek keys. RT.Start/RT.Stop are what make every raw query RT-bounded,
  // which is the difference between 178 ms and 2.97 s.
  rt: "RT",
  rtStart: "RT.Start",
  rtStop: "RT.Stop",
  im: "IM",
  predictedRt: "Predicted.RT",
  predictedIm: "Predicted.IM",
  fwhm: "FWHM",

  qValue: "Q.Value",
  pep: "PEP",
  globalQValue: "Global.Q.Value",
  pgQValue: "PG.Q.Value",
  globalPgQValue: "Global.PG.Q.Value",

  quantity: "Precursor.Quantity",
  normalised: "Precursor.Normalised",
  ms1Area: "Ms1.Area",
  pgMaxLfq: "PG.MaxLFQ",
  genesMaxLfq: "Genes.MaxLFQ",

  evidence: "Evidence",
  massEvidence: "Mass.Evidence",
  quantityQuality: "Quantity.Quality",
} as const;

/**
 * Numeric columns keep whatever width Arrow gave them — DIA-NN writes most of
 * this report as float32, and widening 56 columns to float64 at load costs both
 * time and twice the memory for no gain. Every variant indexes identically.
 */
export type NumericColumn =
  | Float64Array
  | Float32Array
  | Int32Array
  | Int16Array
  | Int8Array
  | Uint32Array
  | Uint16Array
  | Uint8Array;

export type ColumnData = NumericColumn | string[];

const isNumeric = (v: unknown): v is NumericColumn =>
  ArrayBuffer.isView(v) && !(v instanceof DataView) &&
  !(v instanceof BigInt64Array) && !(v instanceof BigUint64Array);

export interface ReportTable {
  readonly rowCount: number;
  /** Columns decoded so far. Text columns appear here once first read. */
  readonly columns: ReadonlyMap<string, ColumnData>;
  /** Every column name in the file, decoded or not. */
  readonly columnNames: readonly string[];
  /** Distinct run names, in first-seen order. */
  readonly runs: readonly string[];
  /** Run name per row, as an index into `runs`. */
  readonly runOf: Int32Array;
  /** Column names present in the file but not in CANONICAL. */
  readonly extra: readonly string[];
  /** Canonical names the file does not have. Absence is never fatal. */
  readonly missing: readonly string[];
  column(name: string): ColumnData | undefined;
  /** Numeric accessor that tolerates absence — returns null, never throws. */
  numeric(name: string): NumericColumn | null;
  text(name: string): string[] | null;
}

export interface FilterSpec {
  /** Precursor q-value ceiling. The FDR slider. */
  maxQValue?: number;
  /** Drop decoys. */
  hideDecoys?: boolean;
  /** Keep only proteotypic precursors. */
  proteotypicOnly?: boolean;
  /** Restrict to one run, by index into `runs`. */
  run?: number;
  /** Free-text match against sequence, gene, or protein. */
  search?: string;
}

/** Loads a report from a plain `.parquet` file. */
export async function loadReport(path: string): Promise<ReportTable> {
  const reader = await FileRangeReader.open(path);
  const pf = await ParquetFile.fromFile(
    new RangeBlob(reader, 0, reader.size) as unknown as File,
  );
  try {
    const wasm = await pf.read();
    return fromArrow(tableFromIPC(wasm.intoIPCStream()));
  } finally {
    pf.free();
    await reader.close();
  }
}

export function fromArrow(tbl: Table): ReportTable {
  const columns = new Map<string, ColumnData>();

  // String columns are decoded on first use, not at load.
  //
  // A report has ~15 text columns and only two or three are ever read in bulk;
  // the rest are shown for whichever handful of rows is on screen. Materialising
  // all of them up front cost 12 s on a 269k-row report — most of it building
  // JS strings nobody asked for.
  const lazy = new Map<string, Vector>();

  for (const field of tbl.schema.fields) {
    const vec = tbl.getChild(field.name);
    if (!vec) continue;
    const t = String(field.type);
    if (t.startsWith("Utf8") || t.startsWith("LargeUtf8") || t.startsWith("Dictionary")) {
      lazy.set(field.name, vec);
    } else if (t.startsWith("Bool")) {
      const out = new Uint8Array(tbl.numRows);
      for (let i = 0; i < tbl.numRows; i++) out[i] = vec.get(i) ? 1 : 0;
      columns.set(field.name, out);
    } else {
      const arr = vec.toArray();
      if (isNumeric(arr)) {
        // Zero-copy, whatever the width. Matching only float64/int32 here sent
        // 56 of this report's columns down the per-row path below and turned a
        // 275 ms decode into a 9 s load.
        columns.set(field.name, arr);
      } else if (arr instanceof BigInt64Array || arr instanceof BigUint64Array) {
        // int64 is unwieldy downstream and nothing here needs 64 bits of range;
        // widen once at load rather than at every read.
        const out = new Float64Array(arr.length);
        for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]!);
        columns.set(field.name, out);
      } else {
        const out = new Float64Array(tbl.numRows);
        for (let i = 0; i < tbl.numRows; i++) out[i] = Number(vec.get(i) ?? NaN);
        columns.set(field.name, out);
      }
    }
  }

  const materialise = (name: string): string[] | undefined => {
    const done = columns.get(name);
    if (done) return Array.isArray(done) ? done : undefined;
    const vec = lazy.get(name);
    if (!vec) return undefined;
    const out = new Array<string>(tbl.numRows);
    for (let i = 0; i < tbl.numRows; i++) out[i] = String(vec.get(i) ?? "");
    columns.set(name, out);
    lazy.delete(name);
    return out;
  };

  const known = new Set<string>(Object.values(CANONICAL));
  const present = new Set<string>([...columns.keys(), ...lazy.keys()]);
  const extra = [...present].filter((c) => !known.has(c));
  const missing = [...known].filter((c) => !present.has(c));

  // Runs, in first-seen order. `Run` is present in parquet even though
  // `File.Name` deliberately is not (DIA-NN #1105).
  const runCol = materialise(CANONICAL.run);
  const runs: string[] = [];
  const runIdx = new Map<string, number>();
  const runOf = new Int32Array(tbl.numRows);
  if (runCol) {
    for (let i = 0; i < runCol.length; i++) {
      const r = runCol[i]!;
      let k = runIdx.get(r);
      if (k === undefined) {
        k = runs.length;
        runs.push(r);
        runIdx.set(r, k);
      }
      runOf[i] = k;
    }
  }

  return {
    rowCount: tbl.numRows,
    columns,
    columnNames: [...present],
    runs,
    runOf,
    extra,
    missing,
    column(n) {
      return columns.get(n) ?? materialise(n);
    },
    numeric(n) {
      const c = columns.get(n);
      return c && !Array.isArray(c) ? c : null;
    },
    text(n) {
      return materialise(n) ?? null;
    },
  };
}

/**
 * Applies a filter and returns matching row indices.
 *
 * Returning indices rather than a new table is what makes the FDR slider
 * instant: the columns never move, and a re-filter is one linear pass over
 * 269k rows — well under a frame.
 */
export function filterRows(t: ReportTable, f: FilterSpec): Uint32Array {
  const q = f.maxQValue !== undefined ? t.numeric(CANONICAL.qValue) : null;
  const decoy = f.hideDecoys ? t.numeric(CANONICAL.decoy) : null;
  const proteo = f.proteotypicOnly ? t.numeric(CANONICAL.proteotypic) : null;
  const seq = f.search ? t.text(CANONICAL.strippedSequence) : null;
  const genes = f.search ? t.text(CANONICAL.genes) : null;
  const prot = f.search ? t.text(CANONICAL.proteinGroup) : null;
  const needle = f.search?.trim().toUpperCase() ?? "";

  const out = new Uint32Array(t.rowCount);
  let n = 0;
  for (let i = 0; i < t.rowCount; i++) {
    if (q && !(q[i]! <= f.maxQValue!)) continue;
    if (decoy && decoy[i] !== 0) continue;
    if (proteo && proteo[i] === 0) continue;
    if (f.run !== undefined && t.runOf[i] !== f.run) continue;
    if (needle) {
      const hit =
        (seq && seq[i]!.toUpperCase().includes(needle)) ||
        (genes && genes[i]!.toUpperCase().includes(needle)) ||
        (prot && prot[i]!.toUpperCase().includes(needle));
      if (!hit) continue;
    }
    out[n++] = i;
  }
  return out.subarray(0, n);
}

/** The seek keys for one row — everything the drilldown needs to query raw data. */
export interface SeekKey {
  run: string;
  sequence: string;
  charge: number;
  precursorMz: number;
  rtStart: number;
  rtStop: number;
  rt: number;
  im: number | null;
  qValue: number;
}

/**
 * Extracts the raw-data coordinates for one report row.
 *
 * `RT.Start`/`RT.Stop` come straight from the engine, so the drilldown is
 * RT-bounded for free on an identified precursor. Where they are absent — an
 * older report, or a precursor with no peak — it falls back to `Predicted.RT`
 * with a margin, which is the *Interrogate* case: a bound we chose rather than
 * one the engine measured, and the UI says so.
 */
export function seekKey(t: ReportTable, row: number, fallbackMargin = 2): SeekKey | null {
  const mz = t.numeric(CANONICAL.precursorMz);
  const seqs = t.text(CANONICAL.strippedSequence);
  if (!mz || !seqs) return null;

  const rt = t.numeric(CANONICAL.rt);
  const rtStart = t.numeric(CANONICAL.rtStart);
  const rtStop = t.numeric(CANONICAL.rtStop);
  const predicted = t.numeric(CANONICAL.predictedRt);
  const im = t.numeric(CANONICAL.im);
  const q = t.numeric(CANONICAL.qValue);
  const z = t.numeric(CANONICAL.charge);

  const centre = rt?.[row] ?? predicted?.[row] ?? NaN;
  let lo = rtStart?.[row] ?? NaN;
  let hi = rtStop?.[row] ?? NaN;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    if (!Number.isFinite(centre)) return null;
    lo = centre - fallbackMargin;
    hi = centre + fallbackMargin;
  }

  return {
    run: t.runs[t.runOf[row]!] ?? "",
    sequence: seqs[row]!,
    charge: z?.[row] ?? 0,
    precursorMz: mz[row]!,
    rtStart: lo,
    rtStop: hi,
    rt: centre,
    im: im && Number.isFinite(im[row]!) ? im[row]! : null,
    qValue: q?.[row] ?? NaN,
  };
}
