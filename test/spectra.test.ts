import { test } from "node:test";
import assert from "node:assert/strict";
import { MzPeakArchive, FACET } from "../src/archive.ts";
import { buildMetadataIndex, verifyOffsets, spectraInRtWindow, framesCovering } from "../src/spectra.ts";
import { readFooter, rowCount, rowGroupRanges, columnStats } from "../src/parquet.ts";
import { SMALL, BIG, have } from "./data.ts";

test("builds a spectrum index from the small archive", { skip: !have(SMALL) }, async () => {
  const a = await MzPeakArchive.open(SMALL);
  const { spectra: idx } = await buildMetadataIndex(a);

  assert.ok(idx.count > 0, "has spectra");
  assert.equal(idx.rowStart.length, idx.count + 1, "offset table is count+1 long");
  assert.equal(idx.rowStart[0], 0, "starts at row 0");
  assert.ok(idx.totalPeaks > 0, "has peaks");

  // Monotonic non-decreasing, and each step equals that spectrum's peak count.
  for (let i = 0; i < idx.count; i++) {
    assert.equal(
      idx.rowStart[i + 1]! - idx.rowStart[i]!,
      idx.peakCount[i],
      `step ${i} equals peakCount`,
    );
  }
  console.log(
    `    ${idx.count} spectra, ${idx.totalPeaks} peak rows, ` +
      `RT ${idx.time[0]!.toFixed(3)}–${idx.time[idx.count - 1]!.toFixed(3)} min`,
  );
  await a.close();
});

// This is spike 1. Nothing in the mzPeak format *declares* that peak-facet rows
// are dense and in spectrum order, so the whole offset-table optimisation rests
// on an undocumented invariant. If this fails, M2 needs a different approach.
test("offset table predicts peak-facet rows exactly (small)", { skip: !have(SMALL) }, async () => {
  const a = await MzPeakArchive.open(SMALL);
  const { spectra: idx } = await buildMetadataIndex(a);
  const { checked, totalRowsMatch } = await verifyOffsets(a, idx, 12);
  assert.ok(checked.length > 0, "sampled at least one spectrum");
  assert.ok(totalRowsMatch, "sum of number_of_peaks equals peak-facet row count");
  console.log(`    verified spectra: ${checked.join(", ")}`);
  await a.close();
});

test("offset table predicts peak-facet rows exactly (1.5 GB timsTOF)", {
  skip: !have(BIG),
}, async () => {
  const a = await MzPeakArchive.open(BIG);
  const t0 = performance.now();
  const meta = await buildMetadataIndex(a);
  const idx = meta.spectra;
  const build = performance.now() - t0;

  const t1 = performance.now();
  const { checked, totalRowsMatch, coverage } = await verifyOffsets(a, idx, 8);
  const verify = performance.now() - t1;

  assert.ok(totalRowsMatch, "sum of number_of_peaks equals peak-facet row count");
  assert.ok(checked.length > 0, "verified at least one spectrum in the readable range");
  assert.equal(idx.duplicateIds, false, "spectrum ids are unique");
  // The facet packs four streams of different lengths into one row space.
  assert.equal(idx.count, 32_700, "spectra");
  assert.equal(meta.precursors.count, 61_956, "precursor rows");
  assert.equal(meta.facetRows, 61_956, "facet rows == longest stream");
  assert.ok(meta.facetRows > idx.count, "row count is NOT the spectrum count");
  assert.equal(idx.totalPeaks, 507_184_228, "sum of number_of_peaks");
  console.log(
    `    ${idx.count} spectra / ${meta.precursors.count} precursors in ` +
      `${meta.facetRows} rows · ${(idx.totalPeaks / 1e6).toFixed(1)} M peaks · ` +
      `build ${build.toFixed(0)} ms · verify ${verify.toFixed(0)} ms · ` +
      `cheap tier reaches ${(coverage * 100).toFixed(2)}% of rows`,
  );
  await a.close();
});

test("RT window selects a contiguous frame range", { skip: !have(BIG) }, async () => {
  const a = await MzPeakArchive.open(BIG);
  const { spectra: idx } = await buildMetadataIndex(a);
  const frames = spectraInRtWindow(idx, 30, 32);
  const first = frames[0]!, last = frames.at(-1)!;
  assert.ok(frames.length > 0, "found frames in 30-32 min");
  assert.ok(idx.time[first]! >= 30 && idx.time[last]! <= 32, "inside the window");
  const frac = frames.length / idx.count;
  console.log(
    `    RT 30–32 min → frames ${first}–${last} (${(frac * 100).toFixed(1)}% of run)`,
  );
  assert.ok(frac < 0.2, "a 2-minute window is a small fraction of the run");
  await a.close();
});

// Evidence for the claim in docs/ARCHITECTURE.md "Correction 1". If this ever
// starts failing, mzPeak gained an m/z index and the architecture can be
// simplified — so it is worth knowing.
test("m/z is not prunable: every row group spans the full axis", {
  skip: !have(BIG),
}, async () => {
  const a = await MzPeakArchive.open(BIG);
  const r = await a.facet(FACET.spectraPeaks);
  const md = await readFooter(r);
  const groups = rowGroupRanges(md);

  const stats = columnStats(md, ["point", "tof"]);
  const present = stats.filter((s) => s !== null) as Array<{ min: unknown; max: unknown }>;
  assert.ok(present.length > 0, "tof column has row-group statistics");

  const mins = present.map((s) => Number(s.min));
  const maxs = present.map((s) => Number(s.max));
  const spanLo = Math.min(...mins), spanHi = Math.max(...maxs);
  // A prunable column would have row groups covering disjoint sub-ranges.
  // Here every group covers essentially the whole axis, so pruning yields zero.
  const widest = Math.max(...present.map((_, i) => maxs[i]! - mins[i]!));
  const coverage = widest / (spanHi - spanLo);

  console.log(
    `    ${groups.length} row groups · tof axis [${spanLo}, ${spanHi}] · ` +
      `widest group covers ${(coverage * 100).toFixed(1)}% of it`,
  );
  assert.ok(coverage > 0.9, "row groups span the full m/z axis — m/z pruning is useless");
  assert.equal(rowCount(md), 507_184_228, "known peak count for this corpus");
  await r.close?.();
  await a.close();
});

// The DIA seek path: precursor m/z + RT window → the MS2 frames that could
// contain its fragments. Without this there is no way to turn a peptide into
// a set of rows.
test("isolation windows resolve a precursor to MS2 frames", { skip: !have(BIG) }, async () => {
  const a = await MzPeakArchive.open(BIG);
  const meta = await buildMetadataIndex(a);
  const idx = meta.spectra;

  // Take a real isolation window from the file and probe its centre.
  const mz = meta.precursors.targetMz[500]!;
  const at = idx.time[meta.precursors.spectrumIndex[500]!]!;
  const frames = framesCovering(meta, mz, at - 0.5, at + 0.5);

  assert.ok(frames.length > 0, `frames cover m/z ${mz.toFixed(2)} near ${at.toFixed(2)} min`);
  for (const f of frames) {
    assert.equal(idx.msLevel[f], 2, "only MS2 frames carry isolation windows");
    assert.ok(Math.abs(idx.time[f]! - at) <= 0.5, "inside the RT window");
  }
  // The rows those frames occupy — what an XIC actually reads.
  const rows = frames.reduce((n, f) => n + idx.peakCount[f]!, 0);
  const pct = (rows / idx.totalPeaks) * 100;
  console.log(
    `    m/z ${mz.toFixed(2)} ±1 min → ${frames.length} frames, ` +
      `${(rows / 1e3).toFixed(0)}k peak rows (${pct.toFixed(3)}% of file)`,
  );
  assert.ok(pct < 1, "an RT-bounded window touches well under 1% of the peaks");
  await a.close();
});
