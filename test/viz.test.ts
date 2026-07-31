/**
 * Visualization primitives — the math half of every view.
 *
 * These test the failure modes catalogued in docs/VIZ-PLAN.md rather than only
 * the happy path, because visualization fails silently: a NaN coordinate or a
 * null map paints a blank panel and throws nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  rtMobilityMap, correlationMatrix,
  type FramePeaks, type RtImBox,
} from "../src/peaks.ts";

/** A FramePeaks holding hand-placed points, with mobility unless suppressed. */
function peaks(
  pts: readonly { mz: number; intensity: number; mobility: number; frame: number }[],
  withMobility = true,
): FramePeaks {
  return {
    mz: Float64Array.from(pts.map((p) => p.mz)),
    intensity: Float64Array.from(pts.map((p) => p.intensity)),
    mobility: withMobility ? Float64Array.from(pts.map((p) => p.mobility)) : null,
    frameOf: Int32Array.from(pts.map((p) => p.frame)),
    frames: [...new Set(pts.map((p) => p.frame))],
    rowsScanned: pts.length,
    rowsDecoded: pts.length,
    rowGroupsRead: 1,
  };
}

/** Frame index → retention time, 0.1 min apart. */
const TIMES = Float64Array.from({ length: 40 }, (_, i) => 10 + i * 0.1);
const RANGE = {
  rtRange: [10, 14] as const,
  mobilityRange: [0.8, 1.2] as const,
};

/* ------------------------------------------------------------------ */
/* rtMobilityMap                                                       */
/* ------------------------------------------------------------------ */

test("a peak lands in the bin its coordinates predict", () => {
  // Frame 20 → RT 12.0, which is the midpoint of [10,14]; mobility 1.0 is the
  // midpoint of [0.8,1.2]. Both must therefore land in the centre bin.
  const m = rtMobilityMap(
    peaks([{ mz: 500, intensity: 1000, mobility: 1.0, frame: 20 }]),
    TIMES, { ...RANGE, nx: 10, ny: 10 },
  )!;
  assert.ok(m, "map should exist for a mobility-bearing archive");

  let hot = -1;
  for (let i = 0; i < m.cells.length; i++) if (m.cells[i]! > 0) hot = i;
  const x = Math.floor(hot / m.ny);   // column-major, as in heatmap()
  const y = hot % m.ny;
  assert.equal(x, 5, "RT 12.0 of [10,14] over 10 bins is column 5");
  assert.equal(y, 5, "1/K0 1.0 of [0.8,1.2] over 10 bins is row 5");
  assert.equal(m.maxIntensity, 1000);
  assert.equal(m.total, 1000);
});

test("a point exactly on the upper bound stays in the last bin", () => {
  // The classic off-by-one: (rtHi - rtLo) * sx is exactly nx, which indexes one
  // past the end of the row unless it is clamped.
  const m = rtMobilityMap(
    peaks([{ mz: 500, intensity: 7, mobility: 1.2, frame: 40 }]),
    Float64Array.from({ length: 41 }, (_, i) => 10 + i * 0.1),  // frame 40 → 14.0
    { ...RANGE, nx: 8, ny: 8 },
  )!;
  assert.equal(m.total, 7, "the boundary point must be binned, not dropped");
  const x = Math.floor(m.cells.findIndex((v) => v > 0) / m.ny);
  const y = m.cells.findIndex((v) => v > 0) % m.ny;
  assert.equal(x, 7, "RT at the exact maximum belongs in the last column");
  assert.equal(y, 7, "1/K0 at the exact maximum belongs in the last row");
});

test("an archive without mobility yields null, not a lying empty grid", () => {
  const m = rtMobilityMap(
    peaks([{ mz: 500, intensity: 1000, mobility: 1.0, frame: 20 }], false),
    TIMES, RANGE,
  );
  assert.equal(m, null,
    "a Q-TOF/SWATH archive cannot support this view and must say so structurally");
});

test("no signal is an all-zero map, which is different from no mobility", () => {
  // The distinction the grid depends on: an empty tile inside a drawn box is
  // the finding. It has to render, so it cannot be null.
  const m = rtMobilityMap(peaks([]), TIMES, { ...RANGE, nx: 4, ny: 4 })!;
  assert.ok(m, "an empty but mobility-capable region still returns a map");
  assert.equal(m.total, 0);
  assert.equal(m.maxIntensity, 0);
  assert.equal(m.cells.length, 16);
  assert.ok(m.cells.every((v) => v === 0), "every cell zero");
  assert.ok(m.cells.every((v) => Number.isFinite(v)), "and none of them NaN");
});

test("signal outside the expected box is counted, not hidden", () => {
  // AlphaViz Fig. 3D: the refuting tiles are NOT blank. They carry intensity
  // that simply sits elsewhere, so in/out must be measured rather than eyeballed.
  const box: RtImBox = { rtMin: 11.9, rtMax: 12.1, imMin: 0.98, imMax: 1.02 };
  const m = rtMobilityMap(peaks([
    { mz: 500, intensity: 100, mobility: 1.0, frame: 20 },   // inside
    { mz: 500, intensity: 900, mobility: 1.15, frame: 35 },  // outside
  ]), TIMES, { ...RANGE, box })!;

  assert.equal(m.inBox, 100);
  assert.equal(m.outBox, 900);
  assert.equal(m.total, 1000);
  assert.ok(m.outBox > m.inBox,
    "a tile can be bright and still be evidence of absence");
});

test("points outside the requested extent are excluded from every total", () => {
  const m = rtMobilityMap(peaks([
    { mz: 500, intensity: 50, mobility: 1.0, frame: 20 },   // in range
    { mz: 500, intensity: 50, mobility: 3.0, frame: 20 },   // mobility too high
  ]), TIMES, RANGE)!;
  assert.equal(m.total, 50, "the out-of-extent point must not be binned");
});

test("log scaling normalises to 1 without inventing structure", () => {
  const m = rtMobilityMap(peaks([
    { mz: 500, intensity: 1_000_000, mobility: 1.0, frame: 20 },
    { mz: 500, intensity: 10, mobility: 0.9, frame: 10 },
  ]), TIMES, { ...RANGE, nx: 10, ny: 10 })!;

  const hi = Math.max(...m.cells);
  assert.ok(Math.abs(hi - 1) < 1e-6, "the brightest bin scales to exactly 1");
  assert.ok(m.cells.every((v) => v >= 0 && v <= 1), "and nothing escapes [0,1]");
  // The faint point survives instead of being crushed to zero — the reason for
  // log scaling — but the caller can still recover the true ratio.
  const faint = m.cells.filter((v) => v > 0 && v < 1);
  assert.equal(faint.length, 1);
  assert.ok(faint[0]! > 0.15, "a 10-count peak beside a 10^6 one stays visible");
  assert.equal(m.maxIntensity, 1_000_000, "absolute intensity is still reportable");
});

test("a degenerate extent is refused rather than divided by zero", () => {
  assert.equal(rtMobilityMap(peaks([]), TIMES,
    { rtRange: [12, 12], mobilityRange: [0.8, 1.2] }), null);
  assert.equal(rtMobilityMap(peaks([]), TIMES,
    { rtRange: [10, 14], mobilityRange: [1.0, 1.0] }), null);
});

/* ------------------------------------------------------------------ */
/* correlationMatrix                                                   */
/* ------------------------------------------------------------------ */

const F = (xs: number[]) => Float64Array.from(xs);

test("correlation is 1 with itself, -1 with its mirror", () => {
  const rising = F([1, 2, 3, 4, 5]);
  const falling = F([5, 4, 3, 2, 1]);
  const { r, n } = correlationMatrix([rising, falling]);
  assert.equal(n, 2);
  assert.ok(Math.abs(r[0]! - 1) < 1e-6, "self-correlation is 1");
  assert.ok(Math.abs(r[3]! - 1) < 1e-6);
  assert.ok(Math.abs(r[1]! + 1) < 1e-6, "an inverted trace is -1");
  assert.equal(r[1], r[2], "and the matrix is symmetric");
});

test("a flat trace yields zeros, never NaN", () => {
  // Zero variance means a zero denominator. Left alone this produces NaN, which
  // paints as a hole and propagates through any downstream mean.
  const { r } = correlationMatrix([F([1, 2, 3, 4]), F([2, 2, 2, 2])]);
  assert.ok(r.every((v) => Number.isFinite(v)), "no NaN anywhere in the matrix");
  assert.equal(r[1], 0, "a flat trace correlates with nothing");
  assert.equal(r[3], 0, "and its diagonal stays blank rather than reading as 1");
});

test("an all-zero trace behaves like a flat one", () => {
  const { r } = correlationMatrix([F([0, 0, 0]), F([1, 5, 2])]);
  assert.ok(r.every((v) => Number.isFinite(v)));
  assert.equal(r[0], 0, "an absent fragment contributes no self-correlation");
});

test("two co-eluting fragments separate from an interferent", () => {
  // The view's whole purpose: a coherent block versus something following its
  // own profile. b-ions peak early, the interferent peaks late.
  const b3 = F([1, 5, 20, 8, 2, 1]);
  const b4 = F([2, 6, 18, 9, 3, 1]);
  const junk = F([9, 3, 1, 2, 7, 14]);
  const { r, n } = correlationMatrix([b3, b4, junk]);

  const at = (a: number, b: number) => r[a * n + b]!;
  assert.ok(at(0, 1) > 0.95, "the two co-eluting fragments correlate tightly");
  assert.ok(at(0, 2) < 0.5, "and neither tracks the interferent");
  assert.ok(at(1, 2) < 0.5);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      assert.equal(at(i, j), at(j, i), "symmetry holds across the matrix");
});

test("an empty input is a valid empty matrix", () => {
  const { r, n } = correlationMatrix([]);
  assert.equal(n, 0);
  assert.equal(r.length, 0);
});

test("coefficients never escape [-1,1]", () => {
  // Float drift on a long, near-identical pair can otherwise land at 1.0000001,
  // which a colour ramp indexed on [-1,1] will read out of bounds.
  const a = F(Array.from({ length: 500 }, (_, i) => Math.sin(i / 7) * 1e6));
  const b = F(Array.from({ length: 500 }, (_, i) => Math.sin(i / 7) * 1e6 + 1e-9));
  const { r } = correlationMatrix([a, b]);
  assert.ok(r.every((v) => v >= -1 && v <= 1), "clamped to the legal range");
});
