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
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same lookup as test/data.ts: ODIA_TEST_REPORT, else test/local-data.json.
const LOCAL = new URL("../local-data.json", import.meta.url);
const REPORT = process.env.ODIA_TEST_REPORT ??
  (existsSync(LOCAL) ? JSON.parse(readFileSync(LOCAL, "utf8")).REPORT : undefined);
if (!REPORT || !existsSync(REPORT)) {
  console.error("set ODIA_TEST_REPORT or REPORT in test/local-data.json to a DIA-NN report.parquet");
  process.exit(2);
}
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
