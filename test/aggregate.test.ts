import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  loadReport, filterRows, CANONICAL, type ColumnData, type ReportTable,
} from "../src/report.ts";
import { byProtein, byRun } from "../src/aggregate.ts";

const REPORT = process.env.ODIA_TEST_REPORT ??
  "/path/to/mzpeak-example-data/diann/agxt-2026/qvalue50/report.parquet";
const have = existsSync(REPORT);
let cached: Awaited<ReturnType<typeof loadReport>> | null = null;
const report = async () => (cached ??= await loadReport(REPORT));

test("run counts dedupe precursor rows and preserve modified forms", () => {
  const columns = new Map<string, ColumnData>([
    [CANONICAL.strippedSequence, ["PEPTIDE", "PEPTIDE", "PEPTIDE", "PEPTIDE"]],
    [CANONICAL.modifiedSequence, ["PEP[Phospho]TIDE", "PEP[Phospho]TIDE",
      "PEPTIDE", "PEP[Phospho]TIDE"]],
    [CANONICAL.charge, new Int32Array([2, 2, 2, 3])],
  ]);
  const t: ReportTable = {
    rowCount: 4,
    columns,
    columnNames: [...columns.keys()],
    runs: ["run-1"],
    runOf: new Int32Array([0, 0, 0, 0]),
    extra: [],
    missing: [],
    column: (name) => columns.get(name),
    cell: (name, row) => {
      const column = columns.get(name);
      return Array.isArray(column) ? column[row] ?? null : null;
    },
    numeric: (name) => {
      const column = columns.get(name);
      return column instanceof Int32Array ? column : null;
    },
    text: (name) => {
      const column = columns.get(name);
      return Array.isArray(column) ? column : null;
    },
  };

  const [run] = byRun(t, new Uint32Array([0, 1, 2, 3]));
  assert.equal(run!.precursors, 3, "duplicate modified-sequence+charge keys collapse");
  assert.equal(run!.peptides, 2, "modified and unmodified forms remain separate");
});

test("protein grain consolidates only matching point-mutant accessions", () => {
  const columns = new Map<string, ColumnData>([
    [CANONICAL.strippedSequence, ["PEPTIDEA", "PEPTIDEN", "OTHER", "UNKNOWN"]],
    [CANONICAL.modifiedSequence, ["PEPTIDEA", "PEPTIDEN", "OTHER", "UNKNOWN"]],
    [CANONICAL.proteinGroup,
      ["AGXTVARA210V", "AGXTVARN22Q", "P99999", "NO_GENE"]],
    [CANONICAL.genes, ["", "", "OTHER1", ""]],
    [CANONICAL.charge, new Int32Array([2, 2, 3, 2])],
    [CANONICAL.qValue, new Float64Array([0.001, 0.002, 0.003, 0.004])],
  ]);
  const t: ReportTable = {
    rowCount: 4,
    columns,
    columnNames: [...columns.keys()],
    runs: ["run-1"],
    runOf: new Int32Array([0, 0, 0, 0]),
    extra: [],
    missing: [],
    column: (name) => columns.get(name),
    cell: (name, row) => {
      const column = columns.get(name);
      return Array.isArray(column) ? column[row] ?? null : null;
    },
    numeric: (name) => {
      const column = columns.get(name);
      return column && !Array.isArray(column) ? column : null;
    },
    text: (name) => {
      const column = columns.get(name);
      return Array.isArray(column) ? column : null;
    },
  };

  const proteins = byProtein(t, new Uint32Array([0, 1, 2, 3]));
  assert.equal(proteins.length, 3);

  const agxt = proteins.find((protein) => protein.proteinGroup === "AGXT");
  assert.ok(agxt);
  assert.equal(agxt.genes, "AGXT");
  assert.equal(agxt.peptides, 2);
  assert.equal(agxt.precursors, 2);
  assert.equal(agxt.observations, 2);

  const unrelated = proteins.find((protein) => protein.proteinGroup === "P99999");
  assert.ok(unrelated);
  assert.equal(unrelated.genes, "OTHER1");
  assert.equal(unrelated.peptides, 1);

  const blankGene = proteins.find((protein) => protein.proteinGroup === "NO_GENE");
  assert.ok(blankGene);
  assert.equal(blankGene.genes, "", "blank Genes is not invented for a non-variant");
});

// The design's claim is that grains are the same evidence counted differently.
// If aggregation read anything other than the filtered set, the FDR slider would
// move the precursor list and leave the protein list behind — which is exactly
// the matrix-versus-report disagreement that made DIA-NN #1056 take three rounds
// with its author to explain.
test("every grain follows the same filter", { skip: !have }, async () => {
  const t = await report();
  const tight = filterRows(t, { maxQValue: 0.001, hideDecoys: true });
  const loose = filterRows(t, { maxQValue: 0.05, hideDecoys: true });
  assert.ok(loose.length > tight.length, "relaxing FDR admits precursors");

  const pTight = byProtein(t, tight);
  const pLoose = byProtein(t, loose);
  assert.ok(pLoose.length >= pTight.length, "and admits proteins");

  const rTight = byRun(t, tight);
  const rLoose = byRun(t, loose);
  assert.equal(rTight.length, rLoose.length, "run count is fixed by the experiment");
  const sum = (rs: { precursors: number }[]) => rs.reduce((n, r) => n + r.precursors, 0);
  assert.equal(sum(rTight), tight.length, "runs partition the filtered set exactly");
  assert.equal(sum(rLoose), loose.length);
  console.log(
    `    q<=0.001: ${tight.length} precursors, ${pTight.length} proteins · ` +
      `q<=0.05: ${loose.length}, ${pLoose.length}`,
  );
});

test("protein rows are internally consistent", { skip: !have }, async () => {
  const t = await report();
  const rows = filterRows(t, { maxQValue: 0.01, hideDecoys: true });
  const ps = byProtein(t, rows);
  assert.ok(ps.length > 100);

  let observations = 0;
  let precursors = 0;
  for (const p of ps) {
    assert.ok(p.proteinGroup.length > 0, "every group is named");
    assert.ok(p.peptides <= p.precursors, "a peptide can have several charge states");
    // The distinction the review caught: a precursor seen in six runs is six
    // observations but one precursor. Labelling rows "precursors" overstated
    // protein evidence by roughly the run count.
    assert.ok(p.precursors <= p.observations, "precursors never exceed observations");
    assert.ok(p.runs >= 1 && p.runs <= t.runs.length, "run count is in range");
    assert.ok(p.exemplar >= 0 && p.exemplar < t.rowCount, "exemplar is a real row");
    // Quantity is the engine's MaxLFQ or nothing — never a cross-run sum, which
    // would conflate abundance with run count and missingness.
    assert.ok(p.quantity === null || p.quantity > 0);
    if (p.quantity === null) assert.ok(p.quantityNote, "absence is explained");
    observations += p.observations;
    precursors += p.precursors;
  }
  assert.equal(observations, rows.length, "observations partition the filtered set");
  assert.ok(precursors < observations, "a six-run cohort must collapse observations");
  console.log(`    ${ps.length} protein groups · ${precursors.toLocaleString()} precursors ` +
    `from ${observations.toLocaleString()} observations`);
});

test("run rows carry usable QC numbers", { skip: !have }, async () => {
  const t = await report();
  const rows = filterRows(t, { maxQValue: 0.01, hideDecoys: true });
  const rs = byRun(t, rows);
  assert.equal(rs.length, 6);
  for (const r of rs) {
    assert.ok(r.precursors > 0, `${r.name} has identifications`);
    assert.ok(r.peptides <= r.precursors);
    assert.ok(r.proteins <= r.peptides, "proteins group peptides");
    // diaPASEF peaks are seconds wide; minutes would mean a unit slip.
    assert.ok(r.medianFwhmSec > 0.5 && r.medianFwhmSec < 120,
      `FWHM ${r.medianFwhmSec.toFixed(1)} s is implausible`);
    assert.ok(r.rtRange[1] > r.rtRange[0], "RT range is ordered");
  }
  const w = rs.map((r) => r.medianFwhmSec);
  console.log(`    FWHM ${Math.min(...w).toFixed(1)}–${Math.max(...w).toFixed(1)} s · ` +
    `proteins ${rs.map((r) => r.proteins).join("/")}`);
});

test("aggregation of an empty filter is empty, not a crash", { skip: !have }, async () => {
  const t = await report();
  const none = filterRows(t, { maxQValue: -1 });
  assert.equal(none.length, 0);
  assert.deepEqual(byProtein(t, none), []);
  const rs = byRun(t, none);
  assert.equal(rs.length, 6, "runs still listed");
  assert.ok(rs.every((r) => r.precursors === 0));
});
