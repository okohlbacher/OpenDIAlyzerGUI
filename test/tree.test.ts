import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  loadReport, filterRows, CANONICAL, type ColumnData, type ReportTable,
} from "../src/report.ts";
import { buildTree, flatten, idsAtLevel, pathTo, chargeLabel } from "../src/tree.ts";

const REPORT = process.env.ODIA_TEST_REPORT ??
  "/path/to/mzpeak-example-data/diann/agxt-2026/qvalue50/report.parquet";
const have = existsSync(REPORT);
let cached: Awaited<ReturnType<typeof loadReport>> | null = null;
const report = async () => (cached ??= await loadReport(REPORT));

test("charge renders the way this field reads it", () => {
  // Skyline's convention, which users of both incumbents already recognise.
  assert.equal(chargeLabel(1), "+");
  assert.equal(chargeLabel(3), "+++");
  assert.equal(chargeLabel(5), ", +5", "beyond 4 the repeated plus stops being readable");
  assert.equal(chargeLabel(0), "");
});

test("a finite q replaces a NaN incumbent for exemplars and run leaves", () => {
  const columns = new Map<string, ColumnData>([
    [CANONICAL.modifiedSequence, ["PEPTIDE", "PEPTIDE"]],
    [CANONICAL.strippedSequence, ["PEPTIDE", "PEPTIDE"]],
    [CANONICAL.proteinGroup, ["P1", "P1"]],
    [CANONICAL.genes, ["GENE1", "GENE1"]],
    [CANONICAL.charge, new Float64Array([2, 2])],
    [CANONICAL.precursorMz, new Float64Array([500, 500])],
    [CANONICAL.qValue, new Float64Array([NaN, 0.001])],
    [CANONICAL.rt, new Float64Array([10, 11])],
  ]);
  const t: ReportTable = {
    rowCount: 2,
    columns,
    columnNames: [...columns.keys()],
    runs: ["run-1"],
    runOf: new Int32Array([0, 0]),
    extra: [],
    missing: [],
    column: (name) => columns.get(name),
    cell: (name, row) => {
      const value = columns.get(name);
      return Array.isArray(value) ? (value[row] ?? null) : null;
    },
    numeric: (name) => {
      const value = columns.get(name);
      return value && !Array.isArray(value) ? value : null;
    },
    text: (name) => {
      const value = columns.get(name);
      return Array.isArray(value) ? value : null;
    },
  };

  const protein = buildTree(t, new Uint32Array([0, 1]))[0]!;
  const peptide = protein.children[0]!;
  const precursor = peptide.children[0]!;
  assert.equal(protein.exemplar, 1);
  assert.equal(peptide.exemplar, 1);
  assert.equal(precursor.exemplar, 1);
  assert.equal(precursor.children[0]!.exemplar, 1);
});

// The point of the tree. If this ratio is ~1 the tree is doing nothing.
test("every sequence appears once", { skip: !have }, async () => {
  const t = await report();
  const rows = filterRows(t, { maxQValue: 0.01, hideDecoys: true });
  const tree = buildTree(t, rows);

  const peptideIds = new Set<string>();
  let peptides = 0;
  for (const p of tree) for (const pep of p.children) { peptides++; peptideIds.add(pep.id); }
  assert.equal(peptideIds.size, peptides, "no peptide node is duplicated");
  assert.ok(rows.length / peptides > 3, "at least a 3x reduction on a six-run cohort");
  console.log(`    ${rows.length.toLocaleString()} rows -> ${peptides.toLocaleString()} peptide ` +
    `nodes (${(rows.length / peptides).toFixed(1)}x)`);
});

// Merging a phosphopeptide with its unmodified form would be a scientific
// error, not a display convenience: different molecule, different RT.
test("modified forms are separate peptides", { skip: !have }, async () => {
  const t = await report();
  const mod = t.text(CANONICAL.modifiedSequence);
  const strip = t.text(CANONICAL.strippedSequence)!;
  if (!mod) return;

  // Find a stripped sequence carrying more than one modified form.
  const forms = new Map<string, Set<string>>();
  const rows = filterRows(t, { maxQValue: 0.05, hideDecoys: true });
  for (const i of rows) {
    const s = strip[i]!;
    (forms.get(s) ?? forms.set(s, new Set()).get(s)!).add(mod[i]!);
  }
  const multi = [...forms].find(([, v]) => v.size > 1);
  if (!multi) return; // nothing to prove on this cohort

  const tree = buildTree(t, rows);
  let nodes = 0;
  for (const p of tree) for (const pep of p.children) if (pep.label === multi[0]) nodes++;
  assert.ok(nodes >= multi[1].size,
    `${multi[0]} has ${multi[1].size} modified forms but only ${nodes} node(s)`);
  console.log(`    "${multi[0]}" kept as ${multi[1].size} distinct forms`);
});

test("cohort counts never exceed the runs that exist", { skip: !have }, async () => {
  const t = await report();
  const rows = filterRows(t, { maxQValue: 0.01, hideDecoys: true });
  const tree = buildTree(t, rows);
  for (const p of tree.slice(0, 200)) {
    assert.ok(p.seen >= 1 && p.seen <= t.runs.length, `protein seen ${p.seen}/${p.total}`);
    for (const pep of p.children) {
      assert.ok(pep.seen <= p.seen, "a peptide cannot appear in more runs than its protein");
      for (const pre of pep.children) {
        assert.ok(pre.seen <= pep.seen, "nor a precursor than its peptide");
        // Run leaves are the ground truth the count summarises.
        assert.equal(pre.children.length, pre.seen, "count matches the leaves");
        const runs = new Set(pre.children.map((c) => c.runIndex));
        assert.equal(runs.size, pre.children.length, "one leaf per run, no duplicates");
      }
    }
  }
});

test("flattening only walks what is open", { skip: !have }, async () => {
  const t = await report();
  const rows = filterRows(t, { maxQValue: 0.01, hideDecoys: true });
  const tree = buildTree(t, rows);

  const collapsed = flatten(tree, new Set());
  assert.equal(collapsed.length, tree.length, "collapsed costs one row per protein");
  assert.ok(collapsed.every((r) => r.depth === 0));

  // Opening one protein adds exactly its peptides.
  const one = flatten(tree, new Set([tree[0]!.id]));
  assert.equal(one.length, tree.length + tree[0]!.children.length);

  const t0 = performance.now();
  const full = flatten(tree, idsAtLevel(tree, ["protein", "peptide", "precursor"]));
  const ms = performance.now() - t0;
  assert.ok(full.length > rows.length, "expand-all exposes every leaf");
  assert.ok(ms < 1000, `expand-all flatten took ${ms.toFixed(0)} ms`);
  console.log(`    collapsed ${collapsed.length.toLocaleString()} rows · ` +
    `expand-all ${full.length.toLocaleString()} rows in ${ms.toFixed(0)} ms`);
});

test("a node can be revealed from its id", { skip: !have }, async () => {
  const t = await report();
  const rows = filterRows(t, { maxQValue: 0.001, hideDecoys: true });
  const tree = buildTree(t, rows);
  const target = tree[0]!.children[0]!.children[0]!;   // a precursor
  const path = pathTo(tree, target.id);
  assert.ok(path, "path found");
  assert.equal(path!.length, 3, "protein, peptide, precursor");
  assert.equal(path!.at(-1), target.id);
  assert.equal(pathTo(tree, "no-such-node"), null);

  // Opening the path makes the node visible.
  const rowsVisible = flatten(tree, new Set(path!));
  assert.ok(rowsVisible.some((r) => r.node.id === target.id));
});

test("an empty filter gives an empty tree, not a crash", { skip: !have }, async () => {
  const t = await report();
  assert.deepEqual(buildTree(t, filterRows(t, { maxQValue: -1 })), []);
  assert.deepEqual(flatten([], new Set()), []);
});
