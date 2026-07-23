/**
 * Grains — the same filtered rows, counted at a different level.
 *
 * `docs/UI-DESIGN.md` claims QC is not a separate screen but the Runs grain,
 * and that proteins are not a separate view but a coarser count of the same
 * evidence. That only holds if aggregation reads the *filtered* precursor set,
 * so moving the FDR slider moves every grain at once. It does.
 *
 * Protein-level numbers are derived here rather than read from
 * `report.pg_matrix.tsv`, which disagrees with the report it came from — DIA-NN
 * #1056 took three rounds with the author to reconstruct the filter, and the
 * answer involved an undocumented threshold. One source of truth.
 */
import { CANONICAL, type ReportTable } from "./report.ts";

export interface ProteinRow {
  proteinGroup: string;
  genes: string;
  /** Distinct precursors — sequence+charge, not precursor×run observations. */
  precursors: number;
  /** Rows behind it. Distinct from `precursors`: six runs of one precursor is
   *  six observations but one precursor, and labelling those the same would
   *  overstate the evidence by roughly the number of runs. */
  observations: number;
  /** Distinct stripped sequences — the number people quote as "peptides". */
  peptides: number;
  /** Runs it was seen in. */
  runs: number;
  /**
   * Lowest protein-group q-value seen. This is the best single observation, not
   * a cohort error rate — a combined probability across runs is a different
   * quantity and we do not compute one. Labelled "best q" in the UI for that
   * reason.
   */
  qValue: number;
  /**
   * The engine's MaxLFQ, **maximum across runs**. Null when it gave none.
   *
   * A single number for a cohort is a summary, not an abundance: the column
   * header must say which summary, or it reads as *the* quantity.
   */
  quantity: number | null;
  /**
   * Why `quantity` is null, when it is.
   *
   * The previous fallback summed every precursor quantity across every run and
   * charge state, which conflates abundance with run count, missingness and
   * charge distribution — a number that cannot be compared between proteins or
   * between cohorts. Showing nothing is better than showing that.
   */
  quantityNote: string | null;
  /** A representative row, so the evidence pane has something to drill into. */
  exemplar: number;
}

export interface RunRow {
  name: string;
  index: number;
  precursors: number;
  peptides: number;
  proteins: number;
  /** Median precursor q-value — a crude but honest depth signal. */
  medianQ: number;
  /** Median chromatographic peak width, in seconds. */
  medianFwhmSec: number;
  /** Summed precursor quantity. */
  totalQuantity: number;
  /** RT of the first and last identification. */
  rtRange: [number, number];
  exemplar: number;
}

/** The conventional median: the mean of the two middle values when even. */
const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
};

/** Groups filtered precursor rows by protein group. */
export function byProtein(t: ReportTable, rows: Uint32Array): ProteinRow[] {
  const pg = t.text(CANONICAL.proteinGroup);
  const seqs = t.text(CANONICAL.strippedSequence);
  // Precursor identity must be the *modified* sequence plus charge, matching
  // src/tree.ts. Keying on the stripped sequence merges a phosphopeptide with
  // its unmodified form, so the protein grain would report fewer precursors
  // than the tree shows for the same protein on any PTM dataset.
  const forms = t.text(CANONICAL.modifiedSequence) ?? seqs;
  if (!pg || !seqs) return [];
  const genes = t.text(CANONICAL.genes);
  const q = t.numeric(CANONICAL.pgQValue) ?? t.numeric(CANONICAL.qValue);
  const lfq = t.numeric(CANONICAL.pgMaxLfq);
  const quant = t.numeric(CANONICAL.quantity);
  const charge = t.numeric(CANONICAL.charge);

  interface Acc {
    peptides: Set<string>;
    precursorKeys: Set<string>;
    runs: Set<number>;
    observations: number;
    qValue: number;
    lfq: number;
    sum: number;
    exemplar: number;
    genes: string;
  }
  const acc = new Map<string, Acc>();

  for (const i of rows) {
    const key = pg[i] || "";
    if (!key) continue;
    let a = acc.get(key);
    if (!a) {
      a = { peptides: new Set(), precursorKeys: new Set(), runs: new Set(),
            observations: 0, qValue: Infinity, lfq: 0, sum: 0, exemplar: i,
            genes: genes?.[i] || "" };
      acc.set(key, a);
    }
    a.observations++;
    a.peptides.add(seqs[i]!);
    a.precursorKeys.add(`${forms![i]}|${charge?.[i] ?? 0}`);
    a.runs.add(t.runOf[i]!);
    a.sum += quant?.[i] ?? 0;
    const qv = q?.[i] ?? NaN;
    if (Number.isFinite(qv) && qv < a.qValue) { a.qValue = qv; a.exemplar = i; }
    // MaxLFQ is a per-(protein, run) value repeated on every row of that group,
    // so the largest across runs is a reasonable single number to show.
    const l = lfq?.[i] ?? 0;
    if (l > a.lfq) a.lfq = l;
  }

  const out: ProteinRow[] = [];
  for (const [key, a] of acc) {
    out.push({
      proteinGroup: key,
      genes: a.genes,
      precursors: a.precursorKeys.size,
      observations: a.observations,
      peptides: a.peptides.size,
      runs: a.runs.size,
      qValue: Number.isFinite(a.qValue) ? a.qValue : NaN,
      quantity: a.lfq > 0 ? a.lfq : null,
      quantityNote: a.lfq > 0 ? null : "no MaxLFQ from the engine",
      exemplar: a.exemplar,
    });
  }
  return out.sort((x, y) => y.peptides - x.peptides || x.qValue - y.qValue);
}

/** Per-run diagnostics from the filtered set — the Runs grain, which is QC. */
export function byRun(t: ReportTable, rows: Uint32Array): RunRow[] {
  const seqs = t.text(CANONICAL.strippedSequence);
  const forms = t.text(CANONICAL.modifiedSequence) ?? seqs;
  const pg = t.text(CANONICAL.proteinGroup);
  const q = t.numeric(CANONICAL.qValue);
  const fwhm = t.numeric(CANONICAL.fwhm);
  const rt = t.numeric(CANONICAL.rt);
  const quant = t.numeric(CANONICAL.quantity);
  const charge = t.numeric(CANONICAL.charge);

  const acc = t.runs.map((name, index) => ({
    name, index,
    precursorKeys: new Set<string>(),
    peptides: new Set<string>(),
    proteins: new Set<string>(),
    qs: [] as number[],
    fwhms: [] as number[],
    total: 0,
    rtMin: Infinity,
    rtMax: -Infinity,
    exemplar: -1,
  }));

  for (const i of rows) {
    const a = acc[t.runOf[i]!];
    if (!a) continue;
    if (a.exemplar < 0) a.exemplar = i;
    if (forms) {
      a.precursorKeys.add(`${forms[i]}|${charge?.[i] ?? 0}`);
      a.peptides.add(forms[i]!);
    }
    if (pg && pg[i]) a.proteins.add(pg[i]!);
    const qv = q?.[i];
    if (qv !== undefined && Number.isFinite(qv)) a.qs.push(qv);
    const w = fwhm?.[i];
    if (w !== undefined && Number.isFinite(w) && w > 0) a.fwhms.push(w);
    a.total += quant?.[i] ?? 0;
    const r = rt?.[i];
    if (r !== undefined && Number.isFinite(r)) {
      if (r < a.rtMin) a.rtMin = r;
      if (r > a.rtMax) a.rtMax = r;
    }
  }

  return acc.map((a) => ({
    name: a.name,
    index: a.index,
    precursors: a.precursorKeys.size,
    peptides: a.peptides.size,
    proteins: a.proteins.size,
    medianQ: median(a.qs),
    // DIA-NN reports FWHM in minutes; seconds is what people compare.
    medianFwhmSec: median(a.fwhms) * 60,
    totalQuantity: a.total,
    rtRange: [
      Number.isFinite(a.rtMin) ? a.rtMin : 0,
      Number.isFinite(a.rtMax) ? a.rtMax : 0,
    ] as [number, number],
    exemplar: a.exemplar,
  }));
}
