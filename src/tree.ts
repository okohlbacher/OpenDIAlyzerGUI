/**
 * The target tree — protein → peptide → precursor → run.
 *
 * A DIA-NN report is one row per (precursor × run), so a six-run cohort repeats
 * every sequence at least six times, and again per charge. On the AGXT data
 * that is 377,775 rows for ~40,000 distinct sequences. The tree exists to make
 * each sequence appear once.
 *
 * Runs are a *leaf* level, collapsed by default. Skyline keeps the run out of
 * the tree entirely and Spectronaut makes it the root; the first cannot express
 * "this peptide in run 3" as a place, and the second reintroduces the
 * redundancy as the skeleton. A collapsed leaf level gives both.
 *
 * Built over index arrays and flattened on demand, so the same virtualisation
 * the table uses applies unchanged: only expanded nodes are materialised.
 */
import { CANONICAL, type ReportTable } from "./report.ts";
import { parseVariant, targetOf } from "./variant.ts";

export type Level = "protein" | "peptide" | "precursor" | "run";

export interface TreeNode {
  level: Level;
  /** Stable identity, unique across the whole tree. */
  id: string;
  label: string;
  /** Secondary text — genes, m/z, q-value. */
  detail: string;
  /** Runs this node was identified in, and how many exist. */
  seen: number;
  total: number;
  children: TreeNode[];
  /** A report row this node stands for, for the evidence pane. */
  exemplar: number;
  /** Counts shown inline rather than in a status bar. */
  counts?: string;
  /** Set on run leaves. */
  runIndex?: number;
}

const CHARGE = ["", "+", "++", "+++", "++++"];
const VARIANT_DETAIL_LIMIT = 5;
/** Skyline's convention, which both tools' users already read. */
export const chargeLabel = (z: number): string =>
  z >= 1 && z <= 4 ? CHARGE[z]! : z > 0 ? `, +${z}` : "";

/**
 * Builds the tree from filtered report rows.
 *
 * Peptide identity is the **modified** sequence, not the stripped one. Merging
 * a phosphopeptide with its unmodified form under one node would be a
 * scientific error, not a display convenience — they are different molecules
 * with different retention times and different biology. The stripped sequence
 * is the *label*; `Modified.Sequence` is the key.
 */
export function buildTree(t: ReportTable, rows: Uint32Array): TreeNode[] {
  const modSeq = t.text(CANONICAL.modifiedSequence) ?? t.text(CANONICAL.strippedSequence);
  const stripped = t.text(CANONICAL.strippedSequence);
  const pg = t.text(CANONICAL.proteinGroup);
  const genes = t.text(CANONICAL.genes);
  if (!modSeq || !stripped) return [];

  const z = t.numeric(CANONICAL.charge);
  const mz = t.numeric(CANONICAL.precursorMz);
  const q = t.numeric(CANONICAL.qValue);
  const rt = t.numeric(CANONICAL.rt);
  const quant = t.numeric(CANONICAL.quantity);
  const nRuns = t.runs.length;

  interface P { node: TreeNode; peptides: Map<string, Pep>; runs: Set<number> }
  interface Pep {
    node: TreeNode;
    precursors: Map<number, Pre>;
    runs: Set<number>;
    variantCodes: Set<string>;
  }
  interface Pre { node: TreeNode; runs: Map<number, TreeNode> }

  const proteins = new Map<string, P>();

  for (const i of rows) {
    const proteinGroup = pg?.[i] || "";
    const variant = parseVariant(proteinGroup);
    // Variant FASTA entries have no Genes value. Consolidate only their exact
    // accession convention; all ordinary protein-group identities stay intact.
    const gk = targetOf(proteinGroup) || "(unassigned)";
    let p = proteins.get(gk);
    if (!p) {
      p = {
        node: {
          level: "protein", id: `P:${gk}`, label: gk, detail: genes?.[i] || "",
          seen: 0, total: nRuns, children: [], exemplar: i,
        },
        peptides: new Map(), runs: new Set(),
      };
      proteins.set(gk, p);
    }

    const mk = modSeq[i]!;
    let pep = p.peptides.get(mk);
    if (!pep) {
      pep = {
        node: {
          level: "peptide", id: `${gk}|${mk}`, label: stripped[i]!,
          detail: mk !== stripped[i] ? mk : "",
          seen: 0, total: nRuns, children: [], exemplar: i,
        },
        precursors: new Map(), runs: new Set(), variantCodes: new Set(),
      };
      p.peptides.set(mk, pep);
      p.node.children.push(pep.node);
    }
    if (variant) pep.variantCodes.add(variant.code);

    const zi = z?.[i] ?? 0;
    let pre = pep.precursors.get(zi);
    if (!pre) {
      pre = {
        node: {
          level: "precursor", id: `${gk}|${mk}|${zi}`,
          label: `${(mz?.[i] ?? 0).toFixed(4)}${chargeLabel(zi)}`,
          detail: "", seen: 0, total: nRuns, children: [], exemplar: i,
        },
        runs: new Map(),
      };
      pep.precursors.set(zi, pre);
      pep.node.children.push(pre.node);
    }

    const r = t.runOf[i]!;
    // One row per (precursor, run) — but a defensive keep-the-best, since a
    // report with several channels or peptidoforms can repeat the pair.
    const prev = pre.runs.get(r);
    const qi = q?.[i] ?? NaN;
    // Compare against the previous row's q-value, not `prev.seen` — that is 1
    // on a run leaf, so `qi < 1` accepted almost anything and the *last*
    // qualifying row won rather than the best.
    const prevQ = prev ? (q?.[prev.exemplar] ?? Infinity) : Infinity;
    // A real NaN in the q column must not let the first-arriving row stay locked in.
    const beatsPrev = Number.isFinite(prevQ) ? qi < prevQ : true;
    if (!prev || (Number.isFinite(qi) && beatsPrev)) {
      const leaf: TreeNode = {
        level: "run", id: `${gk}|${mk}|${zi}|${r}`,
        label: t.runs[r] ?? String(r),
        detail: `q ${fmtQ(qi)} · RT ${(rt?.[i] ?? 0).toFixed(2)}` +
          (quant?.[i] ? ` · ${quant[i]!.toExponential(1)}` : ""),
        seen: 1, total: 1, children: [], exemplar: i, runIndex: r,
      };
      if (prev) pre.node.children[pre.node.children.indexOf(prev)] = leaf;
      else pre.node.children.push(leaf);
      pre.runs.set(r, leaf);
    }
    pep.runs.add(r);
    p.runs.add(r);

    // Keep the best-scoring row as each node's exemplar, so the evidence pane
    // opens on the strongest example rather than whichever came first.
    if (Number.isFinite(qi)) {
      for (const n of [p.node, pep.node, pre.node]) {
        const cur = q?.[n.exemplar] ?? Infinity;
        // A real NaN in the q column must not let the first-arriving row stay locked in.
        if (!Number.isFinite(cur) || qi < cur) n.exemplar = i;
      }
    }
  }

  const out: TreeNode[] = [];
  for (const p of proteins.values()) {
    p.node.seen = p.runs.size;
    p.node.counts = `${p.peptides.size} peptide${p.peptides.size === 1 ? "" : "s"}`;
    for (const pep of p.peptides.values()) {
      pep.node.seen = pep.runs.size;
      pep.node.counts = `${pep.precursors.size} precursor${pep.precursors.size === 1 ? "" : "s"}`;
      if (pep.variantCodes.size) {
        const variants = [...pep.variantCodes].sort();
        const shown = variants.slice(0, VARIANT_DETAIL_LIMIT);
        const more = variants.length - shown.length;
        const variantDetail = `${variants.length === 1 ? "variant" : "variants"} ` +
          shown.join(", ") + (more ? `, +${more} more` : "");
        pep.node.detail += `${pep.node.detail ? " · " : ""}${variantDetail}`;
      }
      for (const pre of pep.precursors.values()) {
        pre.node.seen = pre.runs.size;
        pre.node.detail = `q ${fmtQ(q?.[pre.node.exemplar] ?? NaN)}`;
        pre.node.children.sort((a, b) => (a.runIndex ?? 0) - (b.runIndex ?? 0));
      }
      pep.node.children.sort((a, b) => a.label.localeCompare(b.label));
    }
    p.node.children.sort((a, b) => b.seen - a.seen || a.label.localeCompare(b.label));
    out.push(p.node);
  }
  out.sort((a, b) => b.children.length - a.children.length || a.label.localeCompare(b.label));
  return out;
}

const fmtQ = (v: number) =>
  !Number.isFinite(v) ? "—" : v < 1e-3 ? v.toExponential(0) : v.toFixed(4);

export interface FlatRow {
  node: TreeNode;
  depth: number;
  expandable: boolean;
  expanded: boolean;
}

/**
 * Flattens to the rows that are actually visible.
 *
 * Only expanded subtrees are walked, so a fully collapsed tree of 8,000
 * proteins costs 8,000 steps regardless of how many precursors hang beneath.
 * This is what keeps the same virtualised window the table uses: the flat list
 * is the row array, and rendering is still a slice of it.
 */
export function flatten(roots: readonly TreeNode[], expanded: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number) => {
    for (const n of nodes) {
      const open = expanded.has(n.id);
      out.push({ node: n, depth, expandable: n.children.length > 0, expanded: open });
      if (open && n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** Every node id at or below a level — for expand-all-at-level. */
export function idsAtLevel(roots: readonly TreeNode[], levels: readonly Level[]): Set<string> {
  const want = new Set(levels);
  const out = new Set<string>();
  const walk = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      if (want.has(n.level) && n.children.length) out.add(n.id);
      if (n.children.length) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** Path of ids from a root down to `id`, so the tree can reveal a selection. */
export function pathTo(roots: readonly TreeNode[], id: string): string[] | null {
  const stack: string[] = [];
  const walk = (nodes: readonly TreeNode[]): boolean => {
    for (const n of nodes) {
      stack.push(n.id);
      if (n.id === id || walk(n.children)) return true;
      stack.pop();
    }
    return false;
  };
  return walk(roots) ? stack : null;
}
