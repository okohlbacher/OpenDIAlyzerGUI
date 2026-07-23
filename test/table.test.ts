import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumericFilter, sortIndices, applyColumnFilters } from "../src/table.ts";

test("numeric filters accept what people actually type", () => {
  assert.deepEqual(parseNumericFilter("<0.01"), { min: -Infinity, max: prevOf(0.01) });
  assert.deepEqual(parseNumericFilter(">=2"), { min: 2, max: Infinity });
  assert.deepEqual(parseNumericFilter("400-600"), { min: 400, max: 600 });
  assert.deepEqual(parseNumericFilter("600-400"), { min: 400, max: 600 }, "range order forgiven");
  assert.deepEqual(parseNumericFilter("1e-4"), { min: 1e-4, max: 1e-4 });
  assert.deepEqual(parseNumericFilter(" < 0.05 "), { min: -Infinity, max: prevOf(0.05) });
  // Not numeric — the caller falls back to substring.
  assert.equal(parseNumericFilter("ALBU"), null);
  assert.equal(parseNumericFilter(""), null);
  assert.equal(parseNumericFilter("-"), null);

  // Strict comparisons must exclude the boundary.
  const gt = parseNumericFilter(">5")!;
  assert.ok(5 < gt.min, "> excludes the value itself");
  const lt = parseNumericFilter("<5")!;
  assert.ok(5 > lt.max);
});
const prevOf = (v: number) => v - Math.abs(v) * Number.EPSILON - Number.MIN_VALUE;

test("sorting is stable and puts missing values last", () => {
  const q = [0.5, 0.1, NaN, 0.1, 0.9, NaN];
  const idx = Uint32Array.from([0, 1, 2, 3, 4, 5]);
  const read = (r: number) => q[r]!;

  const asc = Array.from(sortIndices(idx, read, "asc"));
  assert.deepEqual(asc.slice(0, 4), [1, 3, 0, 4], "ties keep original order");
  assert.deepEqual(asc.slice(4), [2, 5], "NaN last");

  const desc = Array.from(sortIndices(idx, read, "desc"));
  assert.deepEqual(desc.slice(0, 4), [4, 0, 1, 3]);
  assert.deepEqual(desc.slice(4), [2, 5], "NaN still last, not promoted by reversing");
});

test("sorting handles text", () => {
  const g = ["ALB", "act", "ZZZ", "Bcl"];
  const idx = Uint32Array.from([0, 1, 2, 3]);
  const asc = Array.from(sortIndices(idx, (r) => g[r]!, "asc"));
  assert.deepEqual(asc.map((i) => g[i]), ["act", "ALB", "Bcl", "ZZZ"], "case-insensitive order");
});

test("column filters combine, numeric and text together", () => {
  const mz = [400, 500, 600, 700];
  const gene = ["ALB", "ACTB", "ALB", "TTN"];
  const idx = Uint32Array.from([0, 1, 2, 3]);

  const byMz = applyColumnFilters(idx, [{ text: "450-650", read: (r) => mz[r]! }]);
  assert.deepEqual(Array.from(byMz), [1, 2]);

  const both = applyColumnFilters(idx, [
    { text: "450-650", read: (r) => mz[r]! },
    { text: "alb", read: (r) => gene[r]! },
  ]);
  assert.deepEqual(Array.from(both), [2], "all filters must match");

  assert.deepEqual(Array.from(applyColumnFilters(idx, [])), [0, 1, 2, 3], "no filter, no change");
  assert.deepEqual(
    Array.from(applyColumnFilters(idx, [{ text: "   ", read: (r) => mz[r]! }])),
    [0, 1, 2, 3], "blank filter is not a filter");
});

test("a numeric filter on a column with gaps drops the gaps", () => {
  const v = [1, NaN, 3, null as unknown as number];
  const idx = Uint32Array.from([0, 1, 2, 3]);
  const out = applyColumnFilters(idx, [{ text: ">0", read: (r) => v[r] }]);
  assert.deepEqual(Array.from(out), [0, 2], "missing is not greater than zero");
});
