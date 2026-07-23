#!/usr/bin/env node
/**
 * Drives the app through a scripted journey and writes the state after each
 * step. `test/ui.test.ts` asserts on the result.
 *
 * Separate from the assertions on purpose: launching Electron takes ~30 s, so
 * the trace is produced once and many tests read it. Re-run this when the UI
 * changes; the committed baseline is what makes it a regression test.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPORT = process.env.ODIA_TEST_REPORT ??
  "/path/to/mzpeak-example-data/diann/agxt-2026/qvalue50/report.parquet";
const OUT = process.argv[2] ?? "test/ui/trace.json";

const script = readFileSync("test/ui/journeys.json", "utf8").replaceAll("REPORT", REPORT);
const dir = mkdtempSync(join(tmpdir(), "odia-ui-"));
const scriptPath = join(dir, "journey.json");
writeFileSync(scriptPath, script);

execFileSync("npx", ["electron", "app/main.mjs"], {
  env: { ...process.env, ODIA_UI_SCRIPT: scriptPath, ODIA_UI_OUT: OUT },
  stdio: "inherit",
  timeout: 15 * 60_000,
});
console.log("wrote", OUT);
