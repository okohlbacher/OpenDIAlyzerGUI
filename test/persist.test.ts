import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Annotation must survive the app closing.
 *
 * It is the one thing here that cannot be recomputed: a report can be re-read
 * and an archive re-converted, but the organism someone looked up is gone if
 * the window closes. This launches Electron twice — the second time touching
 * nothing — and asserts the second run finds what the first typed.
 */
const RAW = "/path/to/raw-data";
const canRun = existsSync(RAW) && existsSync("app/main.mjs");

const drive = (steps: unknown[], out: string) => {
  const dir = mkdtempSync(join(tmpdir(), "odia-persist-"));
  const script = join(dir, "s.json");
  writeFileSync(script, JSON.stringify(steps));
  execFileSync("npx", ["electron", "app/main.mjs"], {
    env: { ...process.env, ODIA_UI_SCRIPT: script, ODIA_UI_OUT: out },
    stdio: "ignore",
    timeout: 5 * 60_000,
  });
  return JSON.parse(readFileSync(out, "utf8")) as { step: string; state: any }[];
};

test("a project survives closing the app", { skip: !canRun, timeout: 600_000 }, () => {
  const files = [1, 2, 3].map((n) => join(RAW, `probe-${n}.d`));
  const outA = join(tmpdir(), "odia-persist-a.json");
  const outB = join(tmpdir(), "odia-persist-b.json");

  // Session one: annotate. Session two: launch and touch nothing.
  const a = drive([
    { do: "screen", screen: "project", settle: 800 },
    { do: "projectFiles", paths: files, settle: 1200 },
    { do: "projectColumn", name: "factor value[persist test]", settle: 700 },
  ], outA).at(-1)!.state;

  const b = drive([{ do: "screen", screen: "project", settle: 1200 }], outB).at(-1)!.state;

  assert.equal(b.sdrfRows, a.sdrfRows, "rows survived the restart");
  assert.equal(b.sdrfCols, a.sdrfCols, "so did the added factor column");
  assert.ok(a.sdrfRows > 0, "the first session actually annotated something");

  // Leave no state behind for the next test run.
  drive([{ do: "screen", screen: "project", settle: 300 },
         { do: "projectClear", settle: 500 }], join(tmpdir(), "odia-persist-c.json"));
  for (const f of [outA, outB]) rmSync(f, { force: true });
});
