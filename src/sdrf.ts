/**
 * SDRF-Proteomics as the run table's columns.
 *
 * `docs/NAVIGATION.md`: experiment design is not a dialog, it is the columns of
 * the table you already have. A factor value typed once is then usable as a
 * filter, a colour-by and a submission field, without a second editor and
 * without an import that immediately diverges from what it imported.
 *
 * "Simplified" means reduced *ceremony*, not a reduced schema: the required
 * columns are present and named exactly as SDRF names them, everything else is
 * addable, and anything imported that we do not model is carried through
 * verbatim rather than dropped.
 */

/** Columns every SDRF-Proteomics file must carry, in canonical order. */
export const REQUIRED = [
  "source name",
  "characteristics[organism]",
  "characteristics[organism part]",
  "characteristics[disease]",
  "assay name",
  "comment[data file]",
  "comment[instrument]",
] as const;

/** Suggested additions, offered but never imposed. */
export const SUGGESTED = [
  "characteristics[cell type]",
  "characteristics[sex]",
  "characteristics[age]",
  "characteristics[biological replicate]",
  "comment[technical replicate]",
  "comment[fraction identifier]",
  "comment[label]",
  "comment[cleavage agent details]",
  "comment[modification parameters]",
] as const;

export interface SdrfRow {
  /** Absolute path to the raw file this row describes. */
  path: string;
  values: Record<string, string>;
}

export interface Sdrf {
  /** Column order, as displayed and as written out. */
  columns: string[];
  rows: SdrfRow[];
}

const stem = (p: string) => {
  const t = p.replace(/[\\/]+$/, "");
  const base = t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

/**
 * Creates rows for dropped files, pre-filling only what the file itself says.
 *
 * Everything else stays blank. Guessing an organism or a disease from a
 * filename would put unverified metadata into a record intended for
 * submission — the one place invention is least acceptable.
 */
export function fromFiles(paths: readonly string[], existing?: Sdrf): Sdrf {
  const columns = existing?.columns.slice() ?? [...REQUIRED];
  const rows = existing?.rows.slice() ?? [];
  const seen = new Set(rows.map((r) => r.path));

  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    const name = stem(p);
    const values: Record<string, string> = {};
    for (const c of columns) values[c] = "";
    values["source name"] = name;
    values["assay name"] = name;
    values["comment[data file]"] = p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
    rows.push({ path: p, values });
  }
  return { columns, rows };
}

export function addColumn(s: Sdrf, name: string): Sdrf {
  const col = name.trim();
  if (!col || s.columns.includes(col)) return s;
  return {
    columns: [...s.columns, col],
    rows: s.rows.map((r) => ({ ...r, values: { ...r.values, [col]: "" } })),
  };
}

export function setValue(s: Sdrf, rowIndex: number, column: string, value: string): Sdrf {
  const rows = s.rows.slice();
  const r = rows[rowIndex];
  if (!r) return s;
  rows[rowIndex] = { ...r, values: { ...r.values, [column]: value } };
  return { columns: s.columns, rows };
}

export interface Issue {
  row: number;
  column: string;
  message: string;
  /** Blocking issues would prevent a valid submission; none prevent analysis. */
  blocking: boolean;
}

/**
 * Reports what is missing, and never blocks.
 *
 * An experiment can be searched before its annotation is finished, and forcing
 * the order round only teaches people to type placeholders — which is worse
 * than a blank, because a blank is honestly empty and "n/a" is not.
 */
export function validate(s: Sdrf): Issue[] {
  const out: Issue[] = [];
  const sources = new Map<string, number>();

  s.rows.forEach((r, i) => {
    for (const c of REQUIRED) {
      if (!(r.values[c] ?? "").trim()) {
        out.push({ row: i, column: c, message: `${c} is empty`, blocking: true });
      }
    }
    const src = (r.values["source name"] ?? "").trim();
    if (src) {
      const prev = sources.get(src);
      if (prev !== undefined) {
        // Repeating a source name is how technical replicates of one sample are
        // expressed, so this is a note rather than an error.
        out.push({
          row: i, column: "source name", blocking: false,
          message: `shares a source name with row ${prev + 1} — replicates of one sample?`,
        });
      } else {
        sources.set(src, i);
      }
    }
  });

  // A factor value is what makes a comparison possible; a design with none is
  // legal but almost certainly unfinished.
  const factors = s.columns.filter((c) => /^factor value\[/i.test(c));
  if (!factors.length && s.rows.length > 1) {
    out.push({
      row: -1, column: "", blocking: false,
      message: "no factor value column — nothing marks what is being compared",
    });
  }
  for (const f of factors) {
    s.rows.forEach((r, i) => {
      if (!(r.values[f] ?? "").trim()) {
        out.push({ row: i, column: f, message: `${f} is empty`, blocking: true });
      }
    });
  }
  return out;
}

/** Serialises to SDRF-Proteomics TSV, column order preserved. */
export function toTsv(s: Sdrf): string {
  const esc = (v: string) => v.replace(/[\t\r\n]/g, " ");
  const lines = [s.columns.join("\t")];
  for (const r of s.rows) lines.push(s.columns.map((c) => esc(r.values[c] ?? "")).join("\t"));
  return lines.join("\n") + "\n";
}

/**
 * Parses SDRF-Proteomics TSV.
 *
 * Unknown columns are kept and round-tripped rather than dropped — the same
 * rule the report loader follows, and for the same reason: silently losing a
 * column someone deliberately added is worse than not understanding it.
 */
export function fromTsv(text: string, resolvePath?: (dataFile: string) => string): Sdrf {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { columns: [...REQUIRED], rows: [] };

  const columns = lines[0]!.split("\t").map((c) => c.trim());
  const rows: SdrfRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const values: Record<string, string> = {};
    columns.forEach((c, i) => (values[c] = (cells[i] ?? "").trim()));
    const file = values["comment[data file]"] ?? values["comment[file uri]"] ?? "";
    rows.push({ path: resolvePath ? resolvePath(file) : file, values });
  }
  return { columns, rows };
}

/**
 * Matches SDRF rows to the runs a report contains.
 *
 * Same rule as pairing archives: match on identity the data already carries,
 * by stem, so a path that has gone stale still resolves.
 */
export function matchRuns(s: Sdrf, runs: readonly string[]): Map<string, SdrfRow | null> {
  // Path stem is derived from the actual file, so it is the authoritative
  // key; data-file/assay-name are free text a person can edit to anything,
  // including — by coincidence or copy-paste — another row's real stem. A
  // user-edited field must never be allowed to steal another row's
  // authoritative match, so every row's path stem is claimed first.
  const byStem = new Map<string, SdrfRow>();
  for (const r of s.rows) byStem.set(stem(r.path), r);
  for (const r of s.rows) {
    const df = r.values["comment[data file]"];
    if (df && !byStem.has(stem(df))) byStem.set(stem(df), r);
    const an = r.values["assay name"];
    if (an && !byStem.has(stem(an))) byStem.set(stem(an), r);
  }
  const out = new Map<string, SdrfRow | null>();
  for (const run of runs) out.set(run, byStem.get(stem(run)) ?? null);
  return out;
}

/** Investigation-level metadata. Four fields, not a schema editor. */
export interface Investigation {
  title: string;
  description: string;
  contact: string;
  publication: string;
}

export const emptyInvestigation = (): Investigation =>
  ({ title: "", description: "", contact: "", publication: "" });
