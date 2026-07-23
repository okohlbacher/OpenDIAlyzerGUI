import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runStem } from "./registry.ts";

// A median under-represents the error distribution's tail, so matching needs a generous margin.
export const MASS_ACCURACY_MARGIN = 5;
// Suspiciously tiny reported values must not narrow the window enough to miss real fragments.
export const MIN_FRAGMENT_PPM = 8;
// A missing decimal or malformed scale must not blow the matching window open.
export const MAX_FRAGMENT_PPM = 40;
// Reports without usable stats retain the established extraction behaviour.
export const DEFAULT_FRAGMENT_PPM = 20;

/**
 * Reads DIA-NN's corrected, per-run MS2 mass accuracy when it is available.
 *
 * Stats are advisory: an absent or malformed sidecar must never prevent raw
 * evidence from opening.
 */
export async function measuredMs2Ppm(reportDir: string, run: string): Promise<number | null> {
  try {
    const text = await readFile(join(reportDir, "report.stats.tsv"), "utf8");
    const lines = text.split(/\r?\n/);
    const header = lines[0]?.split("\t") ?? [];
    const file = header.indexOf("File.Name");
    const corrected = header.indexOf("Median.Mass.Acc.MS2.Corrected");
    if (file < 0 || corrected < 0) return null;

    const wanted = runStem(run);
    for (const line of lines.slice(1)) {
      const fields = line.split("\t");
      if (runStem(fields[file] ?? "") !== wanted) continue;
      const value = Number(fields[corrected]);
      return Number.isFinite(value) && value > 0 ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function fragmentTolerancePpm(measuredPpm: number | null): number {
  if (measuredPpm === null) return DEFAULT_FRAGMENT_PPM;
  return Math.min(MAX_FRAGMENT_PPM, Math.max(MIN_FRAGMENT_PPM,
    measuredPpm * MASS_ACCURACY_MARGIN));
}
