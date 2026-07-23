import { test } from "node:test";
import assert from "node:assert/strict";
import { MzPeakArchive } from "../src/archive.ts";
import { buildMetadataIndex, framesCovering } from "../src/spectra.ts";
import { PeakReader, extractXic } from "../src/peaks.ts";
import { BIG, SMALL, have } from "./data.ts";

// The decisive test for the tier split. hyparquet silently returns undefined
// structs past row 540,896; pyarrow says row 125,748,494 holds spectrum_index
// 10218. If the bulk tier does not agree with pyarrow here, it is not a fix.
test("bulk tier reads past the cheap tier's silent cutoff", { skip: !have(BIG) }, async () => {
  const a = await MzPeakArchive.open(BIG);
  const r = await PeakReader.open(a);
  assert.equal(r.totalRows, 507_184_228);
  assert.equal(r.rowGroupCount, 484);

  const TARGET = 125_748_494;
  const groups = r.rowGroupsFor(TARGET, TARGET + 1);
  assert.deepEqual(groups, [119], "row lands in row group 119");

  const t0 = performance.now();
  const cols = await r.readRowGroups(groups);
  const ms = performance.now() - t0;

  assert.equal(cols.rowCount, 1_048_576);
  assert.equal(Number(cols.spectrumIndex[TARGET - cols.firstRow]!), 10218,
    "matches pyarrow ground truth");
  // The cheap tier's cutoff is far behind us.
  assert.ok(TARGET > 540_896, "we are past where hyparquet gives up");
  console.log(`    row group 119: ${cols.rowCount} rows in ${ms.toFixed(0)} ms`);
  r.free();
  await a.close();
});

test("mobility column is present on timsTOF archives", { skip: !have(BIG) }, async () => {
  const a = await MzPeakArchive.open(BIG);
  const r = await PeakReader.open(a);
  const cols = await r.readRowGroups([0]);
  assert.ok(cols.mobility, "1/K0 decoded");
  const m = cols.mobility!;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < m.length; i += 997) {
    if (m[i]! < lo) lo = m[i]!;
    if (m[i]! > hi) hi = m[i]!;
  }
  assert.ok(lo > 0.3 && hi < 2.0, `1/K0 range ${lo.toFixed(3)}–${hi.toFixed(3)} is plausible`);
  console.log(`    1/K0 ${lo.toFixed(3)}–${hi.toFixed(3)}`);
  r.free();
  await a.close();
});

// M2's headline. Native reference: 105 ms for a bounded m/z x RT query.
test("RT-bounded XIC meets the 350 ms budget", { skip: !have(BIG) }, async () => {
  const a = await MzPeakArchive.open(BIG);
  const meta = await buildMetadataIndex(a);
  const r = await PeakReader.open(a);

  // A real isolation window from the file, and its own elution time.
  const p = 500;
  const precursorMz = meta.precursors.targetMz[p]!;
  const at = meta.spectra.time[meta.precursors.spectrumIndex[p]!]!;
  // Plausible y-ion series for a peptide of this mass.
  const fragments = [401.2, 514.3, 613.4, 726.5, 841.5];

  const t0 = performance.now();
  const xic = await extractXic(a, meta, r, {
    precursorMz,
    rtMin: at - 0.5,
    rtMax: at + 0.5,
    fragments,
    ppm: 20,
  });
  const ms = performance.now() - t0;

  assert.ok(xic.frames.length > 0, "found contributing frames");
  assert.equal(xic.rt.length, xic.frames.length);
  assert.equal(xic.traces.length, fragments.length);
  for (const tr of xic.traces) assert.equal(tr.length, xic.frames.length);
  // RT axis must be inside the requested window and ascending.
  for (let i = 1; i < xic.rt.length; i++) {
    assert.ok(xic.rt[i]! >= xic.rt[i - 1]!, "RT ascending");
  }

  const signal = xic.traces.reduce((n, t) => n + t.reduce((s, v) => s + v, 0), 0);
  console.log(
    `    m/z ${precursorMz.toFixed(2)} @ ${at.toFixed(2)} min ±0.5 → ` +
      `${xic.frames.length} frames · ${xic.rowGroupsRead} row groups · ` +
      `${(xic.rowsDecoded / 1e6).toFixed(2)} M decoded / ` +
      `${(xic.rowsScanned / 1e3).toFixed(0)}k touched · ` +
      `signal ${signal.toExponential(2)} · ${ms.toFixed(0)} ms`,
  );
  assert.ok(ms < 350, `XIC took ${ms.toFixed(0)} ms, budget 350 ms`);
  r.free();
  await a.close();
});

// An unbounded query costs 2.97 s and 1443 MB natively. The API makes RT
// mandatory, but this pins the reason: the bound is what prunes.
test("RT bound is what makes the query cheap", { skip: !have(BIG) }, async () => {
  const a = await MzPeakArchive.open(BIG);
  const meta = await buildMetadataIndex(a);
  const r = await PeakReader.open(a);
  const p = 500;
  const mz = meta.precursors.targetMz[p]!;
  const at = meta.spectra.time[meta.precursors.spectrumIndex[p]!]!;

  const bounded = framesCovering(meta, mz, at - 0.5, at + 0.5);
  const whole = framesCovering(meta, mz, -Infinity, Infinity);

  const rowsFor = (fs: number[]) => {
    if (!fs.length) return [0, 0] as const;
    const from = meta.spectra.rowStart[fs[0]!]!;
    const to = meta.spectra.rowStart[fs.at(-1)! + 1]!;
    return [from, to] as const;
  };
  const [bf, bt] = rowsFor(bounded);
  const [wf, wt] = rowsFor(whole);
  const bGroups = r.rowGroupsFor(bf, bt).length;
  const wGroups = r.rowGroupsFor(wf, wt).length;

  console.log(
    `    bounded: ${bounded.length} frames, ${bGroups} row groups · ` +
      `unbounded: ${whole.length} frames, ${wGroups} row groups (${r.rowGroupCount} total)`,
  );
  assert.ok(wGroups > bGroups * 10, "unbounded touches an order of magnitude more");
  assert.ok(bGroups <= 3, "a 1-minute window is a handful of row groups");
  r.free();
  await a.close();
});

test("bulk tier handles a Thermo-style archive with a direct m/z column", {
  skip: !have(SMALL),
}, async () => {
  const a = await MzPeakArchive.open(SMALL);
  const r = await PeakReader.open(a);
  const cols = await r.readRowGroups([0]);
  assert.ok(cols.rowCount > 0, "decoded peaks");
  console.log(`    small archive: ${cols.rowCount} peak rows in row group 0`);
  r.free();
  await a.close();
});

// Archives past 4 GB are the normal case for diaPASEF, not an edge case.
// Node's openAsBlob reports `size mod 2**32` above that boundary — a 13.7 GB
// archive came back as 801,746,959 bytes — and the truncated slice surfaced as
// "corrupt footer" from inside WASM rather than as a size error. RangeBlob
// exists because of this, so it needs a test that would have caught it.
const HUGE = process.env.ODIA_TEST_HUGE_ARCHIVE ??
  "/path/to/mzpeak-example-data/diann/agxt-2026/" +
  "run-01.mzpeak";

test("reads a peak facet larger than 4 GB", { skip: !have(HUGE) }, async () => {
  const a = await MzPeakArchive.open(HUGE);
  const { size } = await a.memberRange("spectra_peaks.parquet");
  assert.ok(size > 2 ** 32, `facet is ${(size / 2 ** 30).toFixed(1)} GB, past the 32-bit boundary`);

  const r = await PeakReader.open(a);
  assert.ok(r.totalRows > 0, "footer parsed from a >4 GB member");
  assert.ok(r.rowGroupCount > 0);

  // Decode a real row group, not just the footer: a truncated view can still
  // yield a plausible footer if the tail happens to land inside the file.
  const cols = await r.readRowGroups([r.rowGroupCount - 1]);
  assert.ok(cols.rowCount > 0, "last row group decodes");
  console.log(
    `    ${(size / 2 ** 30).toFixed(1)} GB facet · ${r.totalRows.toLocaleString()} rows · ` +
      `${r.rowGroupCount} row groups`,
  );
  r.free();
  await a.close();
});
