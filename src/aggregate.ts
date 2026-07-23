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
  /** Filtered precursors supporting it. */
  precursors: number;
  /** Distinct stripped sequences — the number people quote as "peptides". */
  peptides: number;
  /** Runs it was seen in. */
  runs: number;
  /** Best (lowest) protein-group q-value across the filtered rows. */
  qValue: number;
  /** MaxLFQ where the engine gave one, else summed precursor quantity. */
  quantity: number;
  /** True when `quantity` is a fallback sum rather than the engine's MaxLFQ. */
  quantityIsSum: boolean;
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

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  xs.sort((a, b) => a - b);
  return xs[xs.length >> 1]!;
};

/** Groups filtered precursor rows by protein group. */
export function byProtein(t: ReportTable, rows: Uint32Array): ProteinRow[] {
  const pg = t.text(CANONICAL.proteinGroup);
  const seqs = t.text(CANONICAL.strippedSequence);
  if (!pg || !seqs) return [];
  const genes = t.text(CANONICAL.genes);
  const q = t.numeric(CANONICAL.pgQValue) ?? t.numeric(CANONICAL.qValue);
  const lfq = t.numeric(CANONICAL.pgMaxLfq);
  const quant = t.numeric(CANONICAL.quantity);

  interface Acc {
    peptides: Set<string>;
    runs: Set<number>;
    precursors: number;
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
      a = { peptides: new Set(), runs: new Set(), precursors: 0, qValue: Infinity,
            lfq: 0, sum: 0, exemplar: i, genes: genes?.[i] || "" };
      acc.set(key, a);
    }
    a.precursors++;
    a.peptides.add(seqs[i]!);
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
      precursors: a.precursors,
      peptides: a.peptides.size,
      runs: a.runs.size,
      qValue: Number.isFinite(a.qValue) ? a.qValue : NaN,
      quantity: a.lfq > 0 ? a.lfq : a.sum,
      quantityIsSum: !(a.lfq > 0),
      exemplar: a.exemplar,
    });
  }
  return out.sort((x, y) => y.precursors - x.precursors || x.qValue - y.qValue);
}

/** Per-run diagnostics from the filtered set — the Runs grain, which is QC. */
export function byRun(t: ReportTable, rows: Uint32Array): RunRow[] {
  const seqs = t.text(CANONICAL.strippedSequence);
  const pg = t.text(CANONICAL.proteinGroup);
  const q = t.numeric(CANONICAL.qValue);
  const fwhm = t.numeric(CANONICAL.fwhm);
  const rt = t.numeric(CANONICAL.rt);
  const quant = t.numeric(CANONICAL.quantity);

  const acc = t.runs.map((name, index) => ({
    name, index,
    precursors: 0,
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
    a.precursors++;
    if (a.exemplar < 0) a.exemplar = i;
    if (seqs) a.peptides.add(seqs[i]!);
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
    precursors: a.precursors,
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
