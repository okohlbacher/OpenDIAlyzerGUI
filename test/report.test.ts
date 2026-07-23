import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadReport, filterRows, seekKey, CANONICAL } from "../src/report.ts";

// Real DIA-NN 2.6.1 Academia output: 6 human liver diaPASEF runs, AGXT/PH1
// cohort, run on spock 2026-07-19. Not a synthetic fixture.
const REPORT = "/path/to/mzpeak-example-data/diann/agxt-2026/report.parquet";
const have = existsSync(REPORT);

let cached: Awaited<ReturnType<typeof loadReport>> | null = null;
const report = async () => (cached ??= await loadReport(REPORT));

test("loads a real DIA-NN 2.6.1 report", { skip: !have }, async () => {
  const t0 = performance.now();
  const t = await report();
  const ms = performance.now() - t0;
  assert.equal(t.rowCount, 268_948);
  assert.equal(t.runs.length, 6, "six liver samples");
  console.log(`    ${t.rowCount} rows x ${t.columnNames.length} cols in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 2000, `load took ${ms.toFixed(0)} ms, budget 2000 ms`);
  console.log(`    runs: ${t.runs.length}`);
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

// The clinical question this cohort exists to answer: 2 PH1 patients carry
// AGXT variants, 4 controls do not. Searching for the gene is the Interrogate
// entry point, and it must land on real rows.
test("finds the AGXT target of the study", { skip: !have }, async () => {
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
