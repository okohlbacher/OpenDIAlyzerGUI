import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBanner, parseCalibration, plan, explainExit, estimateMemoryGb, PRESETS }
  from "../src/engine.ts";

// Verbatim from DIA-NN 2.6.1 Academia on spock, 2026-07-23.
const BANNER = `DIA-NN 2.6.1 Academia  (Data-Independent Acquisition by Neural Networks)
Compiled on Jun 30 2026 14:41:29
Current date and time: Thu Jul 23 10:45:53 2026
Logical CPU cores: 224`;

test("reads version and edition from the real banner", () => {
  const i = parseBanner(BANNER, "/home/x/diann/diann-linux");
  assert.ok(i);
  assert.equal(i!.version, "2.6.1");
  assert.equal(i!.edition, "Academia", "the edition gates features and must be recorded");
  assert.equal(i!.logicalCores, 224);
  assert.equal(parseBanner("some other program", "/x"), null);
});

// These are the values stage 1 exists to produce, taken from the real log.
test("extracts the calibration stage 2 must pin", () => {
  const log = `[3:16] Scan window radius set to 6
[4:04] Optimised mass accuracy: 7 ppm
[8:31] Recommended MS1 mass accuracy setting: 9 ppm
[12:35] Recommended MS1 mass accuracy setting: 11 ppm
[16:37] Recommended MS1 mass accuracy setting: 10 ppm`;
  const c = parseCalibration(log);
  assert.equal(c.massAccMs2, 7);
  assert.equal(c.scanWindow, 6);
  assert.equal(c.massAccMs1, 10, "median across runs, not the first or last");
  assert.deepEqual(parseCalibration("nothing here"), {});
});

test("plan produces calibrate, one stage per run, then aggregate", () => {
  const runs = ["/data/a.d", "/data/b.d", "/data/c.d"];
  const s = plan({ runs, fasta: "/db/h.fasta", outputDir: "/out",
                   preset: "tryptic", threads: 16 });

  assert.equal(s[0]!.id, "calibrate", "no pinned values, so calibration first");
  assert.equal(s.filter((x) => x.id === "quantify").length, 3, "one stage per run");
  assert.equal(s.at(-1)!.id, "aggregate");
  // Per-file isolation is the point: each quantify stage names exactly one run.
  for (const q of s.filter((x) => x.id === "quantify")) assert.equal(q.runs.length, 1);
  // Only the aggregate stage reuses .quant.
  assert.ok(s.at(-1)!.cfg.includes("--use-quant"));
  assert.ok(!s[1]!.cfg.includes("--use-quant"));

  // Policy must be in every stage, not just the last.
  for (const st of s) {
    assert.ok(st.cfg.includes("--qvalue 0.5"), "write everything, filter later");
    assert.ok(st.cfg.includes("--export-quant"), "the engine's own fragments");
    assert.ok(!st.cfg.includes("--matrices"), "matrices disagree with the report");
    assert.ok(!st.cfg.includes("--xic"), "we read raw ourselves");
    assert.deepEqual(st.argv, ["--cfg", st.cfgPath], "always via a config file");
  }
});

test("pinned calibration skips stage 1 and fixes the accuracies", () => {
  const s = plan({ runs: ["/d/a.d"], outputDir: "/out", preset: "hla1", threads: 8,
                   massAccMs2: 7, massAccMs1: 10, scanWindow: 6 });
  assert.ok(!s.some((x) => x.id === "calibrate"), "already calibrated");
  for (const st of s) {
    assert.ok(st.cfg.includes("--mass-acc 7"), "pinned, so run order cannot change results");
    assert.ok(st.cfg.includes("--window 6"));
  }
});

test("the HLA-I preset admits singly-charged precursors", () => {
  // The commonest silent failure for HLA data is a tryptic default excluding
  // charge 1, which is a large part of the population.
  const f = PRESETS.hla1.flags.join(" ");
  assert.ok(f.includes("--min-pr-charge 1"));
  assert.ok(f.includes("--cut **"), "non-specific digest");
  assert.ok(PRESETS.tryptic.flags.join(" ").includes("--min-pr-charge 2"));
});

test("exit codes become sentences", () => {
  assert.match(explainExit(0xC0000409, ""), /out of memory/i);
  assert.match(explainExit(137, ""), /out of memory/i);
  assert.match(explainExit(1, "ERROR: algorithmic failure: src/diann.cpp: 39414"), /39414/);
  // A dropped flag is a failure, not a warning — it means part of the config
  // silently did not apply.
  assert.match(explainExit(0, "WARNING: unrecognised option [--export\\report]"), /silently dropped/i);
});

test("memory estimate is in the right order for a real library", () => {
  // The AGXT cohort's predicted library: 4.19 M precursors, 6 runs.
  const gb = estimateMemoryGb(4_191_047, 6, false);
  assert.ok(gb > 3 && gb < 8, `estimated ${gb.toFixed(1)} GB`);
  assert.ok(estimateMemoryGb(50e6, 6, false) > 20, "a phospho library is a different problem");
  assert.ok(estimateMemoryGb(4e6, 500, true) > estimateMemoryGb(4e6, 500, false), "MBR costs more");
});
