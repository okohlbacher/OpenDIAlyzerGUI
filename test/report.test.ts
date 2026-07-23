import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadReport, filterRows, seekKey, reportedFragments, CANONICAL } from "../src/report.ts";

// Real DIA-NN 2.6.1 Academia output from a six-run liver diaPASEF cohort — not
// a synthetic fixture. The data is unpublished and lives outside the repo, so
// these tests skip cleanly when it is absent.
const REPORT = process.env.ODIA_TEST_REPORT ??
  "/path/to/mzpeak-example-data/diann/agxt-2026/report.parquet";
const have = existsSync(REPORT);

let cached: Awaited<ReturnType<typeof loadReport>> | null = null;
const report = async () => (cached ??= await loadReport(REPORT));

test("loads a real DIA-NN 2.6.1 report", { skip: !have }, async () => {
  const t0 = performance.now();
  const t = await report();
  const ms = performance.now() - t0;
  assert.ok(t.rowCount > 100_000, "a real cohort report, not a stub");
  assert.equal(t.runs.length, 6, "six runs");
  // Budget scales with the work: the same cohort written at 50 % FDR carries
  // 1.4x the rows and 2.9x the columns, so a fixed millisecond ceiling would
  // only be asserting which fixture happened to be on disk.
  const cells = t.rowCount * t.columnNames.length;
  const nsPerCell = (ms * 1e6) / cells;
  console.log(
    `    ${t.rowCount.toLocaleString()} rows x ${t.columnNames.length} cols in ` +
      `${ms.toFixed(0)} ms (${nsPerCell.toFixed(0)} ns/cell)`,
  );
  assert.ok(nsPerCell < 250, `load ran at ${nsPerCell.toFixed(0)} ns/cell, budget 250`);
});

// The column contract in docs/DIANN-COMPAT.md was derived from the README
// before any real output existed. This is the check that it was right.
test("every documented column exists in real output", { skip: !have }, async () => {
  const t = await report();
  assert.deepEqual(t.missing, [], `contract lists columns the file lacks: ${t.missing.join(", ")}`);
  console.log(`    all ${Object.keys(CANONICAL).length} canonical columns present`);
  console.log(`    ${t.extra.length} extra columns carried through: ${t.extra.slice(0, 6).join(", ")}…`);
});

// DIA-NN #1105: File.Name is intentionally absent from parquet to save RAM.
// A loader that assumes it will fail on every real report.
test("survives the columns DIA-NN deliberately omits", { skip: !have }, async () => {
  const t = await report();
  assert.equal(t.column("File.Name"), undefined, "File.Name absent, as documented");
  assert.ok(t.runs.length > 0, "run identity recovered from Run instead");
  assert.equal(t.numeric("No.Such.Column"), null, "unknown numeric column is null, not a throw");
  assert.equal(t.text("No.Such.Column"), null, "unknown text column is null, not a throw");
});

test("FDR filtering is a linear pass, fast enough for a slider", { skip: !have }, async () => {
  const t = await report();
  const counts: Record<string, number> = {};
  const t0 = performance.now();
  for (const q of [0.001, 0.01, 0.05, 0.5]) {
    counts[String(q)] = filterRows(t, { maxQValue: q, hideDecoys: true }).length;
  }
  const ms = (performance.now() - t0) / 4;

  assert.ok(counts["0.001"]! < counts["0.01"]!, "tightening FDR removes rows");
  assert.ok(counts["0.01"]! <= counts["0.05"]!);
  console.log(
    `    q<=0.001: ${counts["0.001"]} · q<=0.01: ${counts["0.01"]} · ` +
      `q<=0.05: ${counts["0.05"]} · ${ms.toFixed(1)} ms per re-filter`,
  );
  // One frame at 60 Hz is 16.7 ms; the slider must not drop frames.
  assert.ok(ms < 16.7, `re-filter took ${ms.toFixed(1)} ms, budget 16.7 ms`);
});

test("proteotypic and per-run filters compose", { skip: !have }, async () => {
  const t = await report();
  const all = filterRows(t, { maxQValue: 0.01, hideDecoys: true }).length;
  const pt = filterRows(t, { maxQValue: 0.01, hideDecoys: true, proteotypicOnly: true }).length;
  const one = filterRows(t, { maxQValue: 0.01, hideDecoys: true, run: 0 }).length;
  assert.ok(pt <= all, "proteotypic is a subset");
  assert.ok(one < all, "one run is a subset of six");
  console.log(`    all ${all} · proteotypic ${pt} · run[0] ${one}`);
});

// Searching by gene is the Interrogate entry point and must land on real rows.
test("finds the gene of interest", { skip: !have }, async () => {
  const t = await report();
  const hits = filterRows(t, { maxQValue: 0.5, search: "AGXT" });
  assert.ok(hits.length > 0, "AGXT precursors present in the report");
  const seqs = t.text(CANONICAL.strippedSequence)!;
  const genes = t.text(CANONICAL.genes)!;
  const distinct = new Set<string>();
  for (const i of hits) distinct.add(seqs[i]!);
  console.log(`    AGXT: ${hits.length} rows, ${distinct.size} distinct peptides (gene ${genes[hits[0]!]})`);
});

test("seek keys give an RT-bounded window for the drilldown", { skip: !have }, async () => {
  const t = await report();
  const rows = filterRows(t, { maxQValue: 0.01, hideDecoys: true });
  assert.ok(rows.length > 100);

  let bounded = 0;
  let widths = 0;
  for (let k = 0; k < 500; k++) {
    const key = seekKey(t, rows[k]!);
    assert.ok(key, "seek key derivable");
    assert.ok(key!.rtStop > key!.rtStart, "window is non-empty");
    assert.ok(key!.precursorMz > 0, "precursor m/z present");
    // diaPASEF: ion mobility must be there.
    assert.ok(key!.im !== null, "1/K0 present on diaPASEF data");
    widths += key!.rtStop - key!.rtStart;
    if (key!.rtStop - key!.rtStart < 2) bounded++;
  }
  console.log(
    `    500 seek keys · mean RT window ${(widths / 500).toFixed(3)} min · ` +
      `${bounded} tighter than 2 min`,
  );
  assert.ok(bounded > 400, "engine-measured bounds are tight, not fallbacks");
});

// --export-quant writes the engine's own fragments into the report:
// `y6^1/704.372620` is series, ordinal, charge and exact m/z. Using them beats
// computing theoretical ions, which for a long peptide picks the wrong series
// entirely — DIA-NN scored b14++ and short y-ions where a naive y-series guess
// reached for y17-y22.
test("parses the engine's own fragments", { skip: !have }, async () => {
  const t = await report();
  if (!t.columnNames.includes("Fr.0.Id")) return; // report written without --export-quant
  const rows = filterRows(t, { maxQValue: 0.01, hideDecoys: true });

  const f = reportedFragments(t, rows[0]!);
  assert.ok(f && f.length > 0, "fragments recovered");
  for (const x of f!) {
    assert.ok(x.mz > 0, `${x.label} has an m/z`);
    assert.ok(/^[a-z]$/.test(x.series), `series is a letter: ${x.series}`);
    assert.ok(x.ordinal >= 1 && x.charge >= 1);
    assert.ok(/^[a-z]\d+(²⁺)?$/.test(x.label), `label reads as an ion: ${x.label}`);
  }
  // Sorted most intense first — those are the traces worth drawing.
  for (let i = 1; i < f!.length; i++) {
    assert.ok(f![i]!.quantity <= f![i - 1]!.quantity, "descending by quantity");
  }
  console.log(`    ${f!.length} fragments: ${f!.slice(0, 5).map((x) => x.label).join(", ")}…`);
});

// A lookup must not decode the column. Twelve Fr.N.Id columns over a cohort
// report are 4.5 M strings, and materialising them to read twelve values stalled
// the evidence pane long enough to look like a failure.
test("single-cell reads do not materialise the column", { skip: !have }, async () => {
  const t = await report();
  if (!t.columnNames.includes("Fr.0.Id")) return;
  const before = t.columns.size;
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) t.cell("Fr.0.Id", i);
  const ms = performance.now() - t0;
  assert.equal(t.columns.size, before, "column was not materialised");
  assert.ok(ms < 50, `200 cell reads took ${ms.toFixed(1)} ms`);
  console.log(`    200 cell reads in ${ms.toFixed(1)} ms, column still lazy`);
});
