/**
 * Pairing report rows with raw archives.
 *
 * A report covers N runs; each run has its own `.mzpeak`. The join key is not
 * something we invent — both sides already carry it:
 *
 *   DIA-NN report  →  `Run` column          →  "…_S3-A1_1_8225"
 *   mzPeak archive →  metadata.run.id       →  "…_S3-A1_1_8225"
 *
 * Both derive from the raw file's stem, so identity travels with the data.
 *
 * Deliberately NOT done: writing archive paths into the report. That would
 * rewrite the engine's own output, and it would key provenance on a filesystem
 * path — which goes stale the moment anything moves, and is the same mistake
 * that makes DIA-NN's `.quant` reuse fragile (its files are matched by raw
 * filename, so recovering a run can require fabricating empty `.raw` files).
 *
 * Identity is read from *inside* each archive, so renaming a `.mzpeak` does not
 * break the link, and moving the whole experiment costs one folder pick.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { MzPeakArchive } from "./archive.ts";

export interface ArchiveEntry {
  path: string;
  /** `metadata.run.id` — the authoritative identity. */
  runId: string;
  /** Original vendor file name, e.g. `…_8225.d`. A second key worth trying. */
  sourceName: string | null;
  spectra: number | null;
  bytes: number;
}

export interface Registry {
  /** Every archive found, in scan order. */
  entries: ArchiveEntry[];
  /** Resolves a report `Run` value to an archive path, or null. */
  resolve(run: string): string | null;
}

/**
 * Strips directories and any single extension: `/a/b/x_1305.d` → `x_1305`.
 *
 * Splits on both separators rather than using `path.basename`, which only
 * understands the host's. A report searched on Windows records
 * `C:\raw\y_99.raw` and is routinely opened on macOS or Linux — that path has
 * to resolve there, or cross-platform pairing quietly fails.
 */
export function runStem(s: string): string {
  const trimmed = s.replace(/[\\/]+$/, "");
  const base = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Reads the identity out of one archive. Cheap by design — this opens the ZIP
 * central directory and `mzpeak_index.json` only, which is single-digit
 * milliseconds even on a 1.5 GB file, and never touches a peak facet.
 */
export async function identify(path: string): Promise<ArchiveEntry | null> {
  let a: MzPeakArchive | null = null;
  try {
    a = await MzPeakArchive.open(path);
    const m = (a.index.metadata ?? {}) as Record<string, any>;
    const runId = String(m.run?.id ?? "").trim();
    const sourceName = m.file_description?.source_files?.[0]?.name ?? null;
    if (!runId && !sourceName) return null;
    const { size } = await stat(path);
    return {
      path,
      runId: runId || runStem(String(sourceName)),
      sourceName: sourceName ? String(sourceName) : null,
      spectra: null,
      bytes: size,
    };
  } catch {
    return null;
  } finally {
    await a?.close();
  }
}

/**
 * Scans directories for archives and indexes them by run identity.
 *
 * Not recursive beyond one level: raw data lives either beside the report or in
 * a sibling folder, and walking a whole filesystem to find a 10 GB file is a
 * good way to hang on a network mount.
 */
export async function scanArchives(roots: readonly string[]): Promise<Registry> {
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".mzpeak")) continue;
      const p = join(root, n);
      if (seen.has(p)) continue;
      seen.add(p);
      candidates.push(p);
    }
  }

  const entries = (await Promise.all(candidates.map(identify))).filter(
    (e): e is ArchiveEntry => e !== null,
  );

  // Three keys per archive, tried in descending order of authority.
  const byId = new Map<string, string>();
  for (const e of entries) {
    byId.set(e.runId, e.path);
    if (e.sourceName) byId.set(runStem(e.sourceName), e.path);
    byId.set(runStem(e.path), e.path);
  }

  return {
    entries,
    resolve(run) {
      return byId.get(run) ?? byId.get(runStem(run)) ?? null;
    },
  };
}

/**
 * Directories worth scanning for a given report, most likely first.
 *
 * `report.stats.tsv` records the raw paths the search actually used. They are
 * usually stale — the AGXT cohort's say `/scratch/agxt/raw` on a cluster while
 * the files sit on a laptop — but when they are not, they are exact, so they
 * are worth one cheap `readdir` before falling back to guessing.
 */
export function searchRoots(reportDir: string, statsPaths: readonly string[] = []): string[] {
  const roots = [
    reportDir,
    join(reportDir, ".."),
    join(reportDir, "raw"),
    join(reportDir, "..", "raw"),
    join(reportDir, "mzpeak"),
    join(reportDir, "..", "mzpeak"),
  ];
  for (const p of statsPaths) {
    const d = p.replace(/[\\/][^\\/]*$/, "");
    if (d && !roots.includes(d)) roots.push(d);
  }
  return roots;
}
