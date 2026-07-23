import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MzPeakArchive, FACET } from "../src/archive.ts";
import { CountingRangeReader, FileRangeReader } from "../src/range.ts";
import { SMALL, SMALL_DIR, SMALL_CHUNKED, HAS_UV, BIG, have } from "./data.ts";

test("repeated invalid archive opens do not exhaust file handles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mzpeak-invalid-"));
  const path = join(dir, "incomplete.mzpeak");
  await writeFile(path, Buffer.from("PK\x03\x04"));
  try {
    for (let i = 0; i < 256; i++) {
      await assert.rejects(
        () => MzPeakArchive.open(path),
        (e: Error) => e.message === "not a ZIP archive: no end-of-central-directory record",
      );
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("opens a small archive and lists its facets", { skip: !have(SMALL) }, async () => {
  const a = await MzPeakArchive.open(SMALL);
  assert.ok(a.has(FACET.spectraMetadata), "spectra_metadata.parquet present");
  assert.ok(a.has(FACET.spectraPeaks), "spectra_peaks.parquet present");
  assert.ok(a.index.files.length > 0, "index lists files");
  // Every facet in the index must actually be in the container.
  for (const f of a.index.files) assert.ok(a.has(f.name), `${f.name} present`);
  await a.close();
});

test("facet slices start with the Parquet magic", { skip: !have(SMALL) }, async () => {
  const a = await MzPeakArchive.open(SMALL);
  for (const name of [FACET.spectraPeaks, FACET.spectraMetadata, FACET.chromatogramsData]) {
    const f = await a.facet(name);
    const head = await f.read(0, 4);
    const tail = await f.read(f.size - 4, 4);
    const magic = new TextDecoder().decode(head);
    assert.equal(magic, "PAR1", `${name} starts with PAR1`);
    assert.equal(new TextDecoder().decode(tail), "PAR1", `${name} ends with PAR1`);
  }
  await a.close();
});

// The local header's extra field differs in length from the central directory's.
// Computing the data offset from the central record alone yields a plausible-
// looking offset that is silently wrong, so this is the test that matters most.
test("zip and unpacked directory give byte-identical facets", {
  skip: !have(SMALL) || !have(SMALL_DIR),
}, async () => {
  const zip = await MzPeakArchive.open(SMALL);
  const dir = await MzPeakArchive.open(SMALL_DIR);
  for (const name of [FACET.spectraMetadata, FACET.chromatogramsData]) {
    const z = await zip.facet(name);
    const d = await dir.facet(name);
    assert.equal(z.size, d.size, `${name} size matches`);
    assert.deepEqual(
      Buffer.from(await z.read(0, z.size)),
      Buffer.from(await d.read(0, d.size)),
      `${name} bytes match`,
    );
    await d.close?.();
  }
  await zip.close();
  await dir.close();
});

test("chunked and has_uv variants open", { skip: !have(SMALL_CHUNKED) }, async () => {
  for (const p of [SMALL_CHUNKED, HAS_UV]) {
    if (!have(p)) continue;
    const a = await MzPeakArchive.open(p);
    assert.ok(a.memberNames.length > 0);
    await a.close();
  }
});

test("reads outside the slice are refused", { skip: !have(SMALL) }, async () => {
  const a = await MzPeakArchive.open(SMALL);
  const f = await a.facet(FACET.spectraMetadata);
  await assert.rejects(() => f.read(f.size - 1, 2), RangeError);
  await assert.rejects(() => f.read(-1, 1), RangeError);
  await a.close();
});

// ── the budget, asserted rather than hoped for ──────────────────────────────
test("cold open of a 1.5 GB ZIP64 archive is under 50 ms", { skip: !have(BIG) }, async () => {
  const raw = await FileRangeReader.open(BIG);
  const counter = new CountingRangeReader(raw);
  await raw.close();

  const t0 = performance.now();
  const a = await MzPeakArchive.open(BIG);
  const ms = performance.now() - t0;

  assert.ok(a.has(FACET.spectraPeaks), "peaks facet present");
  assert.ok(a.index.files.length > 10, "vendor side-files listed too");
  assert.equal(a.index.metadata?.version, "0.9.0");

  // ZIP64 is the real path here: the archive is over 1 GB with 40+ members.
  const f = await a.facet(FACET.spectraPeaks);
  assert.ok(f.size > 1e9, `peaks facet is ${(f.size / 1e9).toFixed(2)} GB`);
  assert.equal(new TextDecoder().decode(await f.read(0, 4)), "PAR1");

  console.log(`    cold open: ${ms.toFixed(1)} ms, ${a.memberNames.length} members`);
  assert.ok(ms < 50, `cold open took ${ms.toFixed(1)} ms, budget 50 ms`);
  await a.close();
  void counter;
});

test("timsTOF archives expose the TOF→m/z transform", { skip: !have(BIG) }, async () => {
  const a = await MzPeakArchive.open(BIG);
  const c = a.imsCalibration;
  assert.ok(c, "ims_calibration present");
  assert.equal(c.codec, "ims-compact");
  // (a + b*tof)^2 must land inside a plausible m/z range across the TOF axis.
  const lo = a.mzFromTof(0);
  const hi = a.mzFromTof(407_550);
  assert.ok(lo > 50 && lo < 200, `m/z at tof=0 is ${lo.toFixed(2)}`);
  assert.ok(hi > 1000 && hi < 3000, `m/z at tof=407550 is ${hi.toFixed(2)}`);
  assert.ok(hi > lo, "monotonic in tof");
  console.log(`    m/z range: ${lo.toFixed(2)} – ${hi.toFixed(2)}`);
  await a.close();
});
