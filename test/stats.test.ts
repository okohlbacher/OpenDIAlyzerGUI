import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { measuredMs2Ppm, fragmentTolerancePpm } from "../src/stats.ts";

const FIXTURES = join(dirname(import.meta.filename), "fixtures");

test("reads corrected MS2 accuracy by the shared run-stem convention", async () => {
  assert.equal(await measuredMs2Ppm(FIXTURES, "sample-one"), 1.6);
  assert.equal(await measuredMs2Ppm(FIXTURES, "/moved/sample-two.d"), 3.25);
  assert.equal(await measuredMs2Ppm(FIXTURES, "broken"), null);
  assert.equal(await measuredMs2Ppm(FIXTURES, "missing"), null);
});

test("missing stats are advisory, not an error", async () => {
  assert.equal(await measuredMs2Ppm(join(FIXTURES, "absent"), "sample-one"), null);
});

test("fragment tolerance applies margin, floor, ceiling, and fallback", () => {
  assert.equal(fragmentTolerancePpm(null), 20);
  assert.equal(fragmentTolerancePpm(0.2), 8);
  assert.equal(fragmentTolerancePpm(1.6), 8);
  assert.equal(fragmentTolerancePpm(2), 10);
  assert.equal(fragmentTolerancePpm(8), 40);
  assert.equal(fragmentTolerancePpm(20), 40);
});
