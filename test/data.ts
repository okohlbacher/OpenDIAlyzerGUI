/** Shared test-data locations. Skipped cleanly when a corpus is absent. */
import { existsSync } from "node:fs";
const H = "/path/to/hupo-mzpeak";
export const SMALL = `${H}/small.mzpeak`;
export const SMALL_DIR = `${H}/small.unpacked.mzpeak`;
export const SMALL_CHUNKED = `${H}/small.chunked.mzpeak`;
export const HAS_UV = `${H}/has_uv.mzpeak`;
export const BIG =
  "/path/to/mzpeak-example-data/data/general-ms/MSV000099123/" +
  "20240812_NW-NBSD-kgg_30min-Veh-A_rep1_S3-A1_1_8225.mzpeak";
export const have = (p: string) => existsSync(p);
