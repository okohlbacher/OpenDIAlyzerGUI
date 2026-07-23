import { test } from "node:test";
import assert from "node:assert/strict";
import { identify, scanArchives, runStem, searchRoots } from "../src/registry.ts";
import { BIG, SMALL, have } from "./data.ts";
import { dirname } from "node:path";

test("runStem strips directories and one extension", () => {
  assert.equal(runStem("/a/b/x_1305.d"), "x_1305");
  assert.equal(runStem("/a/b/x_1305.d/"), "x_1305");
  assert.equal(runStem("C:\\raw\\y_99.raw"), "y_99");
  assert.equal(runStem("plain"), "plain");
  assert.equal(runStem("/a/b/two.dots.mzpeak"), "two.dots");
});

// The whole pairing design rests on this: identity lives inside the archive,
// so it survives the file being renamed or moved.
test("archive identity comes from inside the file", { skip: !have(BIG) }, async () => {
  const t0 = performance.now();
  const e = await identify(BIG);
  const ms = performance.now() - t0;
  assert.ok(e, "identified");
  assert.equal(e!.runId, "20240812_NW-NBSD-kgg_30min-Veh-A_rep1_S3-A1_1_8225");
  assert.equal(e!.sourceName, "20240812_NW-NBSD-kgg_30min-Veh-A_rep1_S3-A1_1_8225.d");
  // Reading identity must stay cheap enough to scan a folder of them.
  assert.ok(ms < 250, `identify took ${ms.toFixed(0)} ms on a 1.5 GB archive`);
  console.log(`    runId "${e!.runId}" in ${ms.toFixed(0)} ms`);
});

test("a report Run value resolves to its archive", { skip: !have(BIG) }, async () => {
  const reg = await scanArchives([dirname(BIG)]);
  assert.ok(reg.entries.length >= 1);
  // DIA-NN writes the raw stem in `Run`; that is the key.
  const run = "20240812_NW-NBSD-kgg_30min-Veh-A_rep1_S3-A1_1_8225";
  assert.equal(reg.resolve(run), BIG);
  // A full path, as report.stats.tsv records it, must resolve too.
  assert.equal(reg.resolve(`/scratch/agxt/raw/${run}.d`), BIG);
  assert.equal(reg.resolve("not-a-run"), null, "unknown run resolves to null, not a guess");
  console.log(`    ${reg.entries.length} archive(s) indexed from one folder`);
});

test("identify rejects non-archives without throwing", async () => {
  assert.equal(await identify("/definitely/not/here.mzpeak"), null);
  assert.equal(await identify(import.meta.filename), null);
});

test("scanning a missing directory is not an error", async () => {
  const reg = await scanArchives(["/no/such/place", "/also/missing"]);
  assert.deepEqual(reg.entries, []);
  assert.equal(reg.resolve("anything"), null);
});

test("search roots include the report folder and its neighbours", () => {
  const roots = searchRoots("/data/exp/diann", ["/scratch/agxt/raw/a_1305.d"]);
  assert.ok(roots.includes("/data/exp/diann"));
  assert.ok(roots.some((r) => r.endsWith("raw")));
  // A stale path from the search is still worth one cheap readdir.
  assert.ok(roots.includes("/scratch/agxt/raw"));
});

test("small archives identify too", { skip: !have(SMALL) }, async () => {
  const e = await identify(SMALL);
  assert.ok(e, "identified");
  assert.ok(e!.runId.length > 0);
  console.log(`    small archive runId "${e!.runId}"`);
});
