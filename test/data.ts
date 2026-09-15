/**
 * Shared test-data locations. Skipped cleanly when a corpus is absent.
 *
 * Real data never lives in this repository, and its paths are not committed
 * either: a file name can identify an unpublished study or its samples. Each
 * location comes from an `ODIA_TEST_<KEY>` environment variable, or else from
 * an untracked `test/local-data.json` (copy `test/local-data.example.json`).
 * With neither, the key resolves to "" and every test that needs it skips.
 */
import { existsSync, readFileSync } from "node:fs";

const LOCAL = new URL("./local-data.json", import.meta.url);
const local: Record<string, string> =
  existsSync(LOCAL) ? JSON.parse(readFileSync(LOCAL, "utf8")) : {};

export const dataPath = (key: string): string =>
  process.env[`ODIA_TEST_${key}`] ?? local[key] ?? "";

const H = dataPath("HUPO_DIR");
const inHupo = (name: string) => (H ? `${H}/${name}` : "");
export const SMALL = inHupo("small.mzpeak");
export const SMALL_DIR = inHupo("small.unpacked.mzpeak");
export const SMALL_CHUNKED = inHupo("small.chunked.mzpeak");
export const HAS_UV = inHupo("has_uv.mzpeak");

/** The 1.5 GB timsTOF archive from MassIVE MSV000099123. */
export const BIG = dataPath("BIG");
/** A DIA-NN report from the six-run diaPASEF cohort, filtered at q ≤ 0.5. */
export const REPORT = dataPath("REPORT");
/** The same cohort's unfiltered DIA-NN report. */
export const REPORT_FULL = dataPath("REPORT_FULL");
/** One run of that cohort as an mzPeak archive: diaPASEF, peak facet > 4 GB. */
export const DIAPASEF = dataPath("DIAPASEF");

export const have = (p: string) => p !== "" && existsSync(p);
