/**
 * Sorting and per-column filtering, shared by every grain.
 *
 * Both operate on index arrays rather than on rows. That is what keeps them
 * compatible with virtualisation: the columns never move, so sorting 378,000
 * rows is a permutation of a Uint32Array and the rendered window is still just
 * a slice.
 */

/** `>5`, `<=0.01`, `1-10`, `=2`, or plain substring. */
export interface NumericFilter {
  min: number;
  max: number;
}

/**
 * Parses a numeric column filter.
 *
 * People type `<0.01` into a q-value box far more readily than they operate two
 * spinners, and a range like `400-600` is the natural way to say it for m/z.
 * Returns null when the text is not a numeric expression, so the caller can
 * fall back to substring matching.
 */
export function parseNumericFilter(raw: string): NumericFilter | null {
  const s = raw.trim().replace(/\s+/g, "");
  if (!s) return null;

  let m = /^(>=|<=|>|<|=)?(-?[\d.]+(?:[eE][-+]?\d+)?)$/.exec(s);
  if (m) {
    const v = Number(m[2]);
    if (!Number.isFinite(v)) return null;
    switch (m[1]) {
      case ">": return { min: nextAfter(v), max: Infinity };
      case ">=": return { min: v, max: Infinity };
      case "<": return { min: -Infinity, max: prevBefore(v) };
      case "<=": return { min: -Infinity, max: v };
      default: return { min: v, max: v };
    }
  }
  // A range: `400-600`. The leading minus of a negative lower bound is allowed,
  // so the separator is the *second* hyphen in that case.
  m = /^(-?[\d.]+(?:[eE][-+]?\d+)?)-(-?[\d.]+(?:[eE][-+]?\d+)?)$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return null;
}

// Nudge by one representable step so `>5` excludes exactly 5 without an epsilon
// that would be wrong at either end of the range.
const nextAfter = (v: number) => v + Math.abs(v) * Number.EPSILON + Number.MIN_VALUE;
const prevBefore = (v: number) => v - Math.abs(v) * Number.EPSILON - Number.MIN_VALUE;

export type Cell = string | number | null | undefined;
export type CellReader = (row: number) => Cell;

/**
 * Sorts an index array by a column, stably.
 *
 * Stability matters here: sorting by gene and then by q-value should leave equal
 * q-values in gene order, which is how people actually build a view.
 */
export function sortIndices(
  indices: Uint32Array,
  read: CellReader,
  dir: "asc" | "desc",
): Uint32Array {
  const n = indices.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  const keys: Cell[] = new Array(n);
  for (let i = 0; i < n; i++) keys[i] = read(indices[i]!);

  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a: number, b: number): number => {
    const x = keys[a];
    const y = keys[b];
    // Missing values sort last in both directions — an absent q-value is not
    // "the best", and flipping direction should not promote it to the top.
    const xm = x === null || x === undefined || (typeof x === "number" && !Number.isFinite(x));
    const ym = y === null || y === undefined || (typeof y === "number" && !Number.isFinite(y));
    if (xm || ym) return xm && ym ? a - b : xm ? 1 : -1;
    if (typeof x === "number" && typeof y === "number") {
      return x === y ? a - b : (x < y ? -1 : 1) * sign;
    }
    const c = String(x).localeCompare(String(y));
    return c === 0 ? a - b : c * sign;
  };

  const sorted = Array.from(order).sort(cmp);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = indices[sorted[i]!]!;
  return out;
}

export interface ColumnFilter {
  /** Free text, interpreted as a numeric expression when it parses as one. */
  text: string;
  read: CellReader;
}

/** Applies per-column filters, all of which must match. */
export function applyColumnFilters(
  indices: Uint32Array,
  filters: readonly ColumnFilter[],
): Uint32Array {
  const active = filters.filter((f) => f.text.trim() !== "");
  if (!active.length) return indices;

  const compiled = active.map((f) => {
    const num = parseNumericFilter(f.text);
    const needle = f.text.trim().toUpperCase();
    return { read: f.read, num, needle };
  });

  const out = new Uint32Array(indices.length);
  let n = 0;
  outer: for (const row of indices) {
    for (const c of compiled) {
      const v = c.read(row);
      if (c.num) {
        const x = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(x) || x < c.num.min || x > c.num.max) continue outer;
      } else {
        if (v === null || v === undefined) continue outer;
        if (!String(v).toUpperCase().includes(c.needle)) continue outer;
      }
    }
    out[n++] = row;
  }
  return out.subarray(0, n);
}
