import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * UI regression tests.
 *
 * These assert on a recorded journey (`test/ui/trace.json`), not on pixels.
 * A screenshot diff fails when a font renders differently and passes when a
 * chart plots the wrong data — the opposite of what is wanted. The trace
 * records structure and numbers after each step.
 *
 * Regenerate after an intentional UI change:
 *   node test/ui/run-journeys.mjs test/ui/trace.json
 * and read the diff before committing it. That diff *is* the review.
 */
const TRACE = "test/ui/trace.json";
const have = existsSync(TRACE);
const trace: { step: string; error?: string; state: any }[] =
  have ? JSON.parse(readFileSync(TRACE, "utf8")) : [];
const at = (n: number) => trace[n]!.state;

test("the journey completed without a step failing", { skip: !have }, () => {
  const failed = trace.filter((s) => s.error);
  assert.deepEqual(failed, [], `steps errored: ${failed.map((f) => f.step + ": " + f.error)}`);
  assert.equal(trace.length, 15, "every scripted step recorded");
});

test("a session opens with data and evidence", { skip: !have }, () => {
  const s = at(0);
  assert.equal(s.grain, "precursors");
  assert.ok(s.total > 100_000, "a real cohort loaded");
  assert.ok(s.loaded > 0 && s.loaded <= s.total, "a window of rows is rendered");
  assert.ok(s.evidenceTitle, "the evidence pane opens on something");
  assert.ok(s.charts >= 1, "chromatograms drawn");
});

// The FDR slider is the design's central claim: an exploration axis, not a
// commitment. It must actually move the result set in both directions.
test("the FDR slider changes the result set both ways", { skip: !have }, () => {
  const open = at(0).total, tight = at(1).total, loose = at(2).total;
  assert.ok(tight < open, `tightening to q<=0.001 must remove rows (${tight} vs ${open})`);
  assert.ok(loose > open, `relaxing to q<=0.05 must add rows (${loose} vs ${open})`);
});

test("search narrows and clears without residue", { skip: !have }, () => {
  const searched = at(3).total, cleared = at(4).total;
  assert.ok(searched > 0, "the search found something");
  assert.ok(searched < cleared / 10, "and it genuinely narrowed");
  assert.equal(cleared, at(2).total, "clearing restores exactly the prior set");
});

test("sorting reorders without changing membership", { skip: !have }, () => {
  assert.equal(at(5).total, at(4).total, "a sort must never add or drop rows");
  assert.notDeepEqual(at(5).firstRows, at(4).firstRows, "but the top of the list must move");
});

test("a column filter narrows and clears exactly", { skip: !have }, () => {
  assert.ok(at(6).total < at(5).total, "filtering narrows");
  assert.equal(at(7).total, at(5).total, "clearing restores");
});

// Grains are the same evidence counted differently, so they must be strictly
// coarser — never larger than the precursor set they aggregate.
test("each grain is coarser than the one it aggregates", { skip: !have }, () => {
  const precursors = at(7).total, proteins = at(8).total, runs = at(9).total;
  assert.ok(proteins < precursors, "proteins group precursors");
  assert.equal(runs, 6, "one row per run in the cohort");
  assert.ok(runs < proteins);
});

test("the tree removes the per-run redundancy", { skip: !have }, () => {
  const tree = at(10);
  assert.equal(tree.grain, "tree");
  assert.ok(tree.total < at(7).total / 10,
    `collapsed tree (${tree.total}) must be far smaller than ${at(7).total} rows`);
});

test("expanding a level grows the tree and collapsing restores it", { skip: !have }, () => {
  const collapsed = at(10).total, expanded = at(11).total, back = at(12).total;
  assert.ok(expanded > collapsed * 5, "expanding peptides reveals far more rows");
  assert.equal(back, collapsed, "collapsing returns exactly to the starting rows");
});

test("switching grain and back is lossless", { skip: !have }, () => {
  assert.equal(at(13).total, at(7).total,
    "returning to precursors restores the same filtered set");
});

// The evidence pane must reach raw data, not just echo the report.
test("selecting a row reads raw data", { skip: !have }, () => {
  const s = at(14);
  assert.ok(s.evidenceTitle, "a peptide is shown");
  assert.ok(s.charts >= 1, "chromatograms drawn");
  assert.ok(s.hasHeatmap, "the ion mobility map is present");
  assert.match(s.evidenceSource ?? "", /raw/i, "sourced from raw data, not the report");
  assert.equal(s.presenceRuns.length, 6, "the cohort strip covers every run");
});

// The review's critical finding: the UI must not call identifications or
// absences from uncalibrated extraction counts.
test("no banner claims an identification or an absence", { skip: !have }, () => {
  const banned = /\babsent\b|consistent with the peptide|is there but went unreported/i;
  for (const s of trace) {
    for (const b of s.state?.banners ?? []) {
      assert.ok(!banned.test(b), `banner makes an unsupportable claim: "${b}"`);
    }
  }
});

// ── project screen ───────────────────────────────────────────────────────────

const PTRACE = "test/ui/project-trace.json";
const havep = existsSync(PTRACE);
const ptrace: { step: string; error?: string; state: any }[] =
  havep ? JSON.parse(readFileSync(PTRACE, "utf8")) : [];
const pat = (n: number) => ptrace[n]!.state;

test("the project journey completed", { skip: !havep }, () => {
  assert.deepEqual(ptrace.filter((s) => s.error), []);
});

test("an empty project shows the required SDRF columns and nothing else", { skip: !havep }, () => {
  const s = pat(0);
  assert.equal(s.screen, "project");
  assert.equal(s.sdrfRows, 0);
  assert.equal(s.sdrfCols, 7, "the seven required SDRF-Proteomics columns");
});

// Dropping files must produce rows immediately. If Project gated on annotation,
// people would skip it and the design data would never be entered at all.
test("dropped files become annotatable rows at once", { skip: !havep }, () => {
  const s = pat(1);
  assert.equal(s.sdrfRows, 6, "one row per run");
  assert.equal(s.sdrfCols, 7, "no columns invented");
  assert.ok(s.sdrfIssues > 0, "and what is missing is reported");
  assert.match(s.projectCount ?? "", /6 runs/);
});

test("adding a factor column resolves the nothing-to-compare note", { skip: !havep }, () => {
  const before = pat(1), after = pat(2);
  assert.equal(after.sdrfCols, before.sdrfCols + 1);
  assert.ok(after.sdrfIssues < before.sdrfIssues,
    "declaring what is compared removes that note");
});

test("editing a cell keeps the table intact", { skip: !havep }, () => {
  assert.equal(pat(3).sdrfRows, 6);
  assert.equal(pat(3).sdrfCols, 8);
});

// Three places, not three steps: leaving and returning must lose nothing.
test("navigating away and back preserves the project", { skip: !havep }, () => {
  assert.equal(pat(4).screen, "results", "results is reachable mid-annotation");
  assert.equal(pat(5).screen, "project");
  assert.equal(pat(5).sdrfRows, pat(3).sdrfRows, "rows survive the round trip");
  assert.equal(pat(5).sdrfCols, pat(3).sdrfCols, "so do added columns");
});
