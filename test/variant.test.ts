import { test } from "node:test";
import assert from "node:assert/strict";
import { isDiagnostic, parseVariant, targetOf } from "../src/variant.ts";

test("point-mutant accessions expose their gene and short code", () => {
  assert.deepEqual(parseVariant("AGXTVARA210V"), {
    gene: "AGXT",
    wildtype: "A",
    position: 210,
    mutant: "V",
    code: "A210V",
  });
  assert.deepEqual(parseVariant("AGXTVARN22Q"), {
    gene: "AGXT",
    wildtype: "N",
    position: 22,
    mutant: "Q",
    code: "N22Q",
  });
  assert.equal(targetOf("AGXTVARA210V"), "AGXT");
});

test("ordinary and multi-gene protein groups stay byte-for-byte unchanged", () => {
  for (const proteinGroup of ["P21549", "AGXT;AGXT2"]) {
    assert.equal(parseVariant(proteinGroup), null);
    assert.equal(targetOf(proteinGroup), proteinGroup);
  }
});

test("only a single Protein.Ids candidate is diagnostic", () => {
  assert.equal(isDiagnostic("AGXTVARA210V"), true);
  assert.equal(isDiagnostic(" AGXTVARA210V "), true);
  assert.equal(isDiagnostic("AGXTVARA210V;P21549"), false);
  assert.equal(isDiagnostic(""), false);
  assert.equal(isDiagnostic("   "), false);
});
