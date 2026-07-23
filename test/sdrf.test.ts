import { test } from "node:test";
import assert from "node:assert/strict";
import { fromFiles, addColumn, setValue, validate, toTsv, fromTsv, matchRuns, REQUIRED }
  from "../src/sdrf.ts";

test("dropped files become rows without inventing metadata", () => {
  const s = fromFiles(["/data/S08_1305.d", "/data/S23_1320.d"]);
  assert.equal(s.rows.length, 2);
  assert.deepEqual(s.columns, [...REQUIRED]);
  assert.equal(s.rows[0]!.values["source name"], "S08_1305");
  assert.equal(s.rows[0]!.values["comment[data file]"], "S08_1305.d");
  // Guessing organism or disease from a filename would put unverified metadata
  // into a record intended for submission.
  assert.equal(s.rows[0]!.values["characteristics[organism]"], "");
  assert.equal(s.rows[0]!.values["characteristics[disease]"], "");

  // Adding the same file twice must not duplicate it.
  const again = fromFiles(["/data/S08_1305.d", "/data/S26_1323.d"], s);
  assert.equal(again.rows.length, 3);
});

test("a new column appears on every row, blank", () => {
  let s = fromFiles(["/a.d", "/b.d"]);
  s = addColumn(s, "factor value[group]");
  assert.ok(s.columns.includes("factor value[group]"));
  assert.ok(s.rows.every((r) => r.values["factor value[group]"] === ""));
  assert.equal(addColumn(s, "factor value[group]").columns.length, s.columns.length,
    "adding it twice is a no-op");
  assert.equal(addColumn(s, "   ").columns.length, s.columns.length, "blank is not a column");
});

// Validation reports; it must never block. Forcing annotation before analysis
// only teaches people to type placeholders, and "n/a" is worse than empty.
test("validation reports without blocking", () => {
  let s = fromFiles(["/a.d", "/b.d"]);
  const issues = validate(s);
  assert.ok(issues.length > 0, "empty required fields are reported");
  assert.ok(issues.some((i) => i.column === "characteristics[organism]"));
  assert.ok(issues.some((i) => /no factor value/.test(i.message)),
    "a multi-run design with nothing to compare is flagged");

  for (let i = 0; i < s.rows.length; i++) {
    for (const c of REQUIRED) s = setValue(s, i, c, c === "source name" ? `S${i}` : "x");
  }
  assert.deepEqual(validate(s).filter((i) => i.blocking), [], "filling required fields clears it");
});

test("a repeated source name is a note, not an error", () => {
  let s = fromFiles(["/a.d", "/b.d"]);
  s = setValue(s, 0, "source name", "patient1");
  s = setValue(s, 1, "source name", "patient1");
  const dup = validate(s).find((i) => /shares a source name/.test(i.message));
  assert.ok(dup, "flagged");
  assert.equal(dup!.blocking, false, "technical replicates of one sample are legal");
});

test("TSV round-trips, including columns we do not model", () => {
  let s = fromFiles(["/data/x.d"]);
  s = addColumn(s, "factor value[group]");
  s = addColumn(s, "comment[some vendor field]");
  s = setValue(s, 0, "characteristics[organism]", "Homo sapiens");
  s = setValue(s, 0, "factor value[group]", "control");
  s = setValue(s, 0, "comment[some vendor field]", "kept verbatim");

  const back = fromTsv(toTsv(s));
  assert.deepEqual(back.columns, s.columns, "column order preserved");
  assert.equal(back.rows[0]!.values["characteristics[organism]"], "Homo sapiens");
  // Dropping a column someone deliberately added is worse than not
  // understanding it — the same rule the report loader follows.
  assert.equal(back.rows[0]!.values["comment[some vendor field]"], "kept verbatim");
});

test("tabs and newlines in a value cannot corrupt the file", () => {
  let s = fromFiles(["/data/x.d"]);
  s = setValue(s, 0, "characteristics[disease]", "line1\nline2\tcol");
  const tsv = toTsv(s);
  assert.equal(tsv.trim().split("\n").length, 2, "still one header and one row");
  assert.equal(fromTsv(tsv).rows.length, 1);
});

// The same rule as pairing archives: match on identity the data carries, so a
// path that has gone stale still resolves.
test("rows match report runs by stem, not by path", () => {
  const s = fromFiles(["/old/scratch/S08_1305.d", "/old/scratch/S23_1320.d"]);
  const m = matchRuns(s, ["/new/home/S08_1305.d", "S23_1320", "/nope/other.d"]);
  assert.ok(m.get("/new/home/S08_1305.d"), "moved file still matches");
  assert.ok(m.get("S23_1320"), "bare stem matches");
  assert.equal(m.get("/nope/other.d"), null, "an unknown run resolves to null, not a guess");
});

test("an imported file with no data-file column still parses", () => {
  const tsv = "source name\tcharacteristics[organism]\nS1\tHomo sapiens\n";
  const s = fromTsv(tsv);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0]!.values["source name"], "S1");
  assert.deepEqual(fromTsv("").rows, [], "an empty file is empty, not a crash");
});
