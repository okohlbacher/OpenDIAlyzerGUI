/**
 * Electron main — window, and for now the data layer too.
 *
 * `docs/ARCHITECTURE.md` puts the data layer in a renderer Web Worker so it
 * runs unmodified in a browser. That is still the target. It lives in main for
 * this milestone because main is plain Node, so `parquet-wasm`, `openAsBlob`
 * and `fs` all work with no bundling at all — and the renderer talks to it by
 * message passing either way, so moving it is a swap rather than a rewrite.
 */
import { app, BrowserWindow, ipcMain, dialog, nativeImage } from "electron";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { loadReport, filterRows, seekKey, reportedFragments, CANONICAL,
  type ReportTable, type FilterSpec } from "../src/report.ts";
import { MzPeakArchive } from "../src/archive.ts";
import { buildMetadataIndex, type MetadataIndex } from "../src/spectra.ts";
import { PeakReader, extractXic, coelution, fragmentsFor } from "../src/peaks.ts";
import { scanArchives, searchRoots, type Registry } from "../src/registry.ts";
import { byProtein, byRun, type ProteinRow, type RunRow } from "../src/aggregate.ts";

const here = dirname(fileURLToPath(import.meta.url));

const USAGE = `OpenDIAlyzer — workbench for DIA proteomics results

  npm run app                      open empty, then use "Open report…"
  npm run app -- <report.parquet>  open a report directly
  npm run app -- <directory>       open the report found in that directory

The matching .mzpeak archives are paired automatically by run identity; put
them beside the report, or in a raw/ or mzpeak/ folder next to it.`;

/**
 * The path given on the command line, if any.
 *
 * Electron inserts its own argv entries and adds switches of its own, so take
 * the first non-flag argument after the entry point rather than a fixed index.
 */
function cliArgument(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

/**
 * Resolves a user-supplied path to a report file.
 *
 * A directory is the friendlier thing to type and the more likely thing to have
 * on the clipboard, so both are accepted. `report.parquet` wins over any other
 * `.parquet` in the folder, since a run also leaves libraries and site reports
 * behind, and those are not what anyone means.
 */
function resolveReport(input: string): string | null {
  const p = resolve(input);
  if (!existsSync(p)) return null;
  if (!statSync(p).isDirectory()) return p;

  const names = readdirSync(p).filter((n) => n.endsWith(".parquet"));
  const preferred = names.find((n) => n === "report.parquet") ??
    names.find((n) => /(^|[^a-z])report\.parquet$/i.test(n)) ??
    names.find((n) => !/(lib|speclib|site_report)/i.test(n));
  return preferred ? join(p, preferred) : null;
}

/** One run's raw data, opened on first use and kept for the session. */
interface OpenArchive {
  archive: MzPeakArchive;
  meta: MetadataIndex;
  peaks: PeakReader;
  path: string;
}

interface Session {
  report: ReportTable;
  reportPath: string;
  registry: Registry;
  /** run name → resolved archive path, or null if none was found. */
  resolved: Map<string, string | null>;
  /** Opened archives, keyed by path. Opening is deferred: building a metadata
   *  index costs ~1.8 s on a large file, and a six-run report would otherwise
   *  pay for all six before showing a single row. */
  open: Map<string, OpenArchive>;
}
let session: Session | null = null;

async function archiveFor(run: string): Promise<OpenArchive | null> {
  if (!session) return null;
  const path = session.resolved.get(run);
  if (!path) return null;
  const already = session.open.get(path);
  if (already) return already;
  const archive = await MzPeakArchive.open(path);
  const entry: OpenArchive = {
    archive,
    meta: await buildMetadataIndex(archive),
    peaks: await PeakReader.open(archive),
    path,
  };
  session.open.set(path, entry);
  return entry;
}

export type Grain = "precursors" | "proteins" | "runs";

/** Precursor rows matching the current filter. Recomputed on every change. */
let visible: Uint32Array = new Uint32Array(0);
/** The current grain's rows. For precursors this mirrors `visible`. */
let grain: Grain = "precursors";
let proteins: ProteinRow[] = [];
let runRows: RunRow[] = [];

/** How many rows the current grain has. */
function grainCount(): number {
  return grain === "proteins" ? proteins.length
    : grain === "runs" ? runRows.length
    : visible.length;
}

/**
 * Every grain aggregates the *filtered* precursor set, so the FDR slider moves
 * all three at once. Protein counts therefore always agree with the precursor
 * list they came from — which is the disagreement DIA-NN's matrices are famous
 * for (#1056).
 */
function regrain(): void {
  proteins = grain === "proteins" ? byProtein(session!.report, visible) : [];
  runRows = grain === "runs" ? byRun(session!.report, visible) : [];
}

/**
 * `ODIA_SMOKE=<report.parquet>` opens that session, waits for first paint, writes
 * a PNG next to it and exits. Verifying a UI means looking at it; this is the
 * cheapest way to do that without a human at the keyboard.
 */
async function smoke(win: BrowserWindow, reportPath: string): Promise<void> {
  const jump = Number(process.env.ODIA_SMOKE_ROW ?? "3");
  const search = process.env.ODIA_SMOKE_SEARCH;
  const smokeGrain = process.env.ODIA_SMOKE_GRAIN;
  // ODIA_SMOKE_STEP=N simulates holding an arrow key: N selections in quick
  // succession, which is what floods the extractor.
  const step = Number(process.env.ODIA_SMOKE_STEP ?? "0");
  await win.webContents.executeJavaScript(
    `openSession(${JSON.stringify(reportPath)}).then(async () => {
       ${search ? `state.search = ${JSON.stringify(search)};
                   state.fdr = 0.5; await refresh();` : ""}
       ${smokeGrain ? `state.grain = ${JSON.stringify(smokeGrain)};
                       document.querySelectorAll(".grain button").forEach(
                         x => x.setAttribute("aria-pressed", String(x.dataset.grain === state.grain)));
                       await refresh();` : ""}
       select(${search ? 0 : jump});
     })`);
  // select() is async — it may have to load the window the row lives in — so
  // give it time to settle before probing, or the probe races it.
  if (step > 0) {
    const t0 = Date.now();
    await win.webContents.executeJavaScript(
      `(async () => { for (let i = 1; i <= ${step}; i++) { select(${jump} + i); await new Promise(r => setTimeout(r, 25)); } })()`);
    console.log(`stepped ${step} rows in ${Date.now() - t0} ms`);
  }
  await new Promise((r) => setTimeout(r, 5000));
  // ODIA_SMOKE_INTERROGATE=<runIndex> clicks through to question 2.
  const grill = process.env.ODIA_SMOKE_INTERROGATE;
  if (grill) {
    await win.webContents.executeJavaScript(`interrogate(state.sel, ${Number(grill)})`);
    await new Promise((r) => setTimeout(r, 6000));
  }
  const probe = await win.webContents.executeJavaScript(
    `JSON.stringify({ scrollHeight: document.getElementById("scroller").scrollHeight,
                      clientHeight: document.getElementById("scroller").clientHeight,
                      wantHeight: state.total * 29,
                      spacerH: document.querySelector("tr.spacer")?.getBoundingClientRect().height ?? null,
                      total: state.total, first: state.first,
                      loaded: state.rows.length, sel: state.sel,
                      seq: state.rows.find(r => r.k === state.sel)?.seq ?? null,
                      scrollTop: document.getElementById("scroller").scrollTop })`);
  console.log("smoke state:", probe);
  const img = await win.webContents.capturePage();
  const out = process.env.ODIA_SMOKE_OUT ?? "/tmp/odia-smoke.png";
  writeFileSync(out, img.toPNG());
  console.log("smoke capture written to", out);
  app.exit(0);
}

/**
 * Our own mark rather than Electron's default.
 *
 * A packaged build takes its icon from the bundle, but an unpackaged run shows
 * Electron's logo unless the dock icon is set explicitly — and `npm run app` is
 * how this is used every day.
 */
const ICON = join(here, "..", "build", "icon.png");

function createWindow(): void {
  const win = new BrowserWindow({
    icon: existsSync(ICON) ? ICON : undefined,
    width: 1580,
    height: 940,
    minWidth: 1080,
    backgroundColor: "#100f0e",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { preload: join(here, "preload.cjs"), sandbox: false },
  });
  win.loadFile(join(here, "index.html"));

  const smokeTarget = process.env.ODIA_SMOKE;
  if (smokeTarget) {
    win.webContents.once("did-finish-load", () => void smoke(win, smokeTarget));
    return;
  }

  const arg = cliArgument();
  if (!arg) return;
  const report = resolveReport(arg);
  win.webContents.once("did-finish-load", () => {
    if (report) win.webContents.send("session:autoload", report);
    else win.webContents.send("session:autoload-failed", arg);
  });
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock && existsSync(ICON)) {
    app.dock.setIcon(nativeImage.createFromPath(ICON));
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle("session:pick", async () => {
  const r = await dialog.showOpenDialog({
    title: "Open a DIA-NN or OpenDIAlyzer report",
    filters: [{ name: "Report", extensions: ["parquet"] }],
    properties: ["openFile"],
  });
  return r.canceled ? null : r.filePaths[0]!;
});

ipcMain.handle("session:open", async (_e, reportPath: string) => {
  const t0 = performance.now();
  const report = await loadReport(reportPath);
  const loadMs = performance.now() - t0;

  // Pair every run with its archive by the identity both sides already carry.
  const t1 = performance.now();
  const registry = await scanArchives(searchRoots(dirname(reportPath), statsPaths(reportPath)));
  const resolved = new Map<string, string | null>();
  for (const run of report.runs) resolved.set(run, registry.resolve(run));
  const scanMs = performance.now() - t1;

  session = { report, reportPath, registry, resolved, open: new Map() };

  const paired = [...resolved.values()].filter(Boolean).length;
  return {
    name: basename(dirname(reportPath)),
    rowCount: report.rowCount,
    columns: report.columnNames.length,
    runs: report.runs.map((r) => ({ name: r, archive: resolved.get(r) ? basename(resolved.get(r)!) : null })),
    extra: report.extra.length,
    missing: report.missing,
    loadMs,
    scanMs,
    paired,
    found: registry.entries.length,
  };
});

/** Raw paths DIA-NN actually used, from `report.stats.tsv` if it is present. */
function statsPaths(reportPath: string): string[] {
  const f = join(dirname(reportPath), basename(reportPath).replace(/\.parquet$/, "") + ".stats.tsv");
  if (!existsSync(f)) return [];
  try {
    const lines = readFileSync(f, "utf8").split(/\r?\n/).slice(1);
    return lines.map((l) => l.split("\t")[0]!).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Applies a filter and returns the first page.
 *
 * Filtering and paging are separate calls: scrolling a 377,000-row result must
 * not re-run the predicate, and re-filtering must not depend on scroll position.
 */
ipcMain.handle("rows:filter",
  (_e, spec: FilterSpec, offset = 0, limit = 200, g: Grain = "precursors") => {
    if (!session) return { total: 0, rows: [], filterMs: 0, grain: g };
    const t0 = performance.now();
    grain = g;
    visible = filterRows(session.report, spec);
    regrain();
    const ms = performance.now() - t0;
    return { total: grainCount(), rows: page(offset, limit), filterMs: ms, grain };
  });

/** A window of the current filtered set. Pure paging — no predicate re-run. */
ipcMain.handle("rows:page", (_e, offset: number, limit: number) => {
  if (!session) return { total: 0, rows: [] };
  return { total: grainCount(), rows: page(offset, limit) };
});

function page(offset: number, limit: number) {
  if (!session) return [];
  const t = session.report;

  if (grain === "proteins") {
    return proteins.slice(offset, offset + limit).map((p, n) => ({
      k: offset + n, i: p.exemplar,
      proteinGroup: p.proteinGroup, gene: p.genes,
      precursors: p.precursors, peptides: p.peptides, runs: p.runs,
      q: p.qValue, quant: p.quantity, quantityIsSum: p.quantityIsSum,
    }));
  }
  if (grain === "runs") {
    return runRows.slice(offset, offset + limit).map((r, n) => ({
      k: offset + n, i: r.exemplar,
      run: r.name, runIndex: r.index,
      precursors: r.precursors, peptides: r.peptides, proteins: r.proteins,
      q: r.medianQ, fwhm: r.medianFwhmSec, quant: r.totalQuantity,
      rtRange: r.rtRange,
      archive: !!session.resolved.get(r.name),
    }));
  }
  const seq = t.text(CANONICAL.strippedSequence);
  const genes = t.text(CANONICAL.genes);
  const prot = t.text(CANONICAL.proteinGroup);
  const z = t.numeric(CANONICAL.charge);
  const mz = t.numeric(CANONICAL.precursorMz);
  const rt = t.numeric(CANONICAL.rt);
  const q = t.numeric(CANONICAL.qValue);
  const quant = t.numeric(CANONICAL.quantity);
  const im = t.numeric(CANONICAL.im);

  const rows = [];
  const from = Math.max(0, Math.min(offset, visible.length));
  const to = Math.min(from + limit, visible.length);
  for (let k = from; k < to; k++) {
    const i = visible[k]!;
    rows.push({
      k,
      i,
      seq: seq?.[i] ?? "",
      z: z?.[i] ?? 0,
      mz: mz?.[i] ?? 0,
      rt: rt?.[i] ?? 0,
      im: im?.[i] ?? 0,
      q: q?.[i] ?? NaN,
      quant: quant?.[i] ?? 0,
      gene: genes?.[i] || prot?.[i] || "",
      run: t.runs[t.runOf[i]!] ?? "",
    });
  }
  return rows;
}

/**
 * Which runs contain a given precursor, and which do not.
 *
 * This is the shape question 2 actually takes in practice: a peptide is
 * identified in four runs of six, and the interesting question is what is
 * sitting at that coordinate in the other two. Answering it needs no prediction
 * — the runs that *did* find it supply the retention time, which is also what
 * keeps the query RT-bounded and therefore cheap.
 */
ipcMain.handle("evidence:presence", (_e, k: number) => {
  if (!session) return null;
  const t = session.report;
  const row = rowOf(k);
  if (row < 0) return null;
  const seqs = t.text(CANONICAL.strippedSequence);
  const zs = t.numeric(CANONICAL.charge);
  if (!seqs) return null;

  const seq = seqs[row]!;
  const z = zs?.[row] ?? 0;
  const rt = t.numeric(CANONICAL.rt);
  const q = t.numeric(CANONICAL.qValue);
  const quant = t.numeric(CANONICAL.quantity);
  const mz = t.numeric(CANONICAL.precursorMz);

  // Scan rather than index: one linear pass over 378k rows is ~2 ms, and an
  // index would have to be invalidated on every filter change.
  const found = new Map<number, { rt: number; q: number; quant: number; mz: number }>();
  for (let i = 0; i < t.rowCount; i++) {
    if (seqs[i] !== seq) continue;
    if (zs && zs[i] !== z) continue;
    const r = t.runOf[i]!;
    const prev = found.get(r);
    const qv = q?.[i] ?? NaN;
    if (!prev || qv < prev.q) {
      found.set(r, { rt: rt?.[i] ?? NaN, q: qv, quant: quant?.[i] ?? 0, mz: mz?.[i] ?? 0 });
    }
  }

  const runs = t.runs.map((name, i) => ({
    name,
    index: i,
    hit: found.get(i) ?? null,
    archive: !!session!.resolved.get(name),
  }));
  return { sequence: seq, charge: z, runs, foundIn: found.size, of: t.runs.length };
});

/**
 * Extracts evidence for a precursor in a run where it was *not* identified.
 *
 * No engine writes chromatograms for a candidate it rejected, so this cannot be
 * a lookup — it is computed from the sequence against raw data. The retention
 * time is borrowed from the runs that did find it, and the panel says so,
 * because a borrowed coordinate is an assumption and the user is entitled to
 * see which one was made.
 */
ipcMain.handle("evidence:interrogate", async (_e, k: number, runIndex: number) => {
  if (!session) return null;
  const t = session.report;
  const row = rowOf(k);
  if (row < 0) return null;
  const seqs = t.text(CANONICAL.strippedSequence);
  const zs = t.numeric(CANONICAL.charge);
  const rts = t.numeric(CANONICAL.rt);
  const mzs = t.numeric(CANONICAL.precursorMz);
  if (!seqs || !rts || !mzs) return null;

  const seq = seqs[row]!;
  const z = zs?.[row] ?? 2;
  const target = t.runs[runIndex];
  if (!target) return null;

  // Borrow the coordinate from every run that identified it.
  const donors: number[] = [];
  let mz = mzs[row]!;
  for (let i = 0; i < t.rowCount; i++) {
    if (seqs[i] !== seq || (zs && zs[i] !== z)) continue;
    if (t.runOf[i] === runIndex) continue;
    const v = rts[i]!;
    if (Number.isFinite(v)) { donors.push(v); mz = mzs[i]!; }
  }
  if (!donors.length) {
    return { sequence: seq, charge: z, run: target, xic: null, reason: "no-donor-rt" };
  }
  donors.sort((a, b) => a - b);
  const rt = donors[Math.floor(donors.length / 2)]!;
  const spread = donors.length > 1 ? donors.at(-1)! - donors[0]! : 0;
  // Widen for the disagreement between donors plus normal run-to-run RT drift.
  const margin = Math.max(0.25, spread / 2 + 0.15);

  let src: OpenArchive | null = null;
  try {
    src = await archiveFor(target);
  } catch (e) {
    return { sequence: seq, charge: z, run: target, xic: null,
             reason: "archive-failed", detail: describe(e) };
  }
  if (!src) {
    return { sequence: seq, charge: z, run: target, xic: null, reason: "no-archive-for-run" };
  }

  // Borrow the fragment list too, not just the retention time: the runs that
  // identified it know which ions the engine actually scored, and a theoretical
  // guess for a long peptide can miss them entirely.
  let donorRow = -1;
  for (let i = 0; i < t.rowCount; i++) {
    if (seqs[i] === seq && (!zs || zs[i] === z) && t.runOf[i] !== runIndex) { donorRow = i; break; }
  }
  const measured = donorRow >= 0 ? reportedFragments(t, donorRow) : null;
  const frags = measured?.slice(0, 6) ??
    fragmentsFor(seq, z, src.meta.spectra.ms2MzRange);
  const fragments = frags.map((f) => f.mz);
  const t0 = performance.now();
  try {
    const xic = await extractXic(src.archive, src.meta, src.peaks, {
      precursorMz: mz, rtMin: rt - margin, rtMax: rt + margin, fragments, ppm: 20,
    });
    const verdict = coelution(xic.traces);
    return {
      sequence: seq, charge: z, run: target, reason: null,
      borrowedRt: rt, donors: donors.length, margin, precursorMz: mz,
      xic: {
        rt: Array.from(xic.rt),
        traces: xic.traces.map((tr) => Array.from(tr)),
        fragments,
        labels: frags.map((f) => f.label),
        series: frags.map((f) => f.series),
        measured: !!measured,
        frames: xic.frames.length,
        rowGroups: xic.rowGroupsRead,
        rowsDecoded: xic.rowsDecoded,
        rowsScanned: xic.rowsScanned,
        archive: basename(src.path),
        verdict,
        ms: performance.now() - t0,
      },
    };
  } catch (e) {
    return { sequence: seq, charge: z, run: target, xic: null,
             reason: "extract-failed", detail: describe(e) };
  }
});

/** The report row a grain row stands for. */
function rowOf(k: number): number {
  if (grain === "proteins") return proteins[k]?.exemplar ?? -1;
  if (grain === "runs") return runRows[k]?.exemplar ?? -1;
  return k >= 0 && k < visible.length ? visible[k]! : -1;
}

ipcMain.handle("evidence:for", async (_e, k: number) => {
  if (!session) return null;
  const row = rowOf(k);
  if (row < 0) return null;
  const key = seekKey(session.report, row);
  if (!key) return null;

  const t = session.report;
  const extras: Record<string, number> = {};
  for (const [label, col] of [
    ["FWHM", CANONICAL.fwhm],
    ["Ms1.Area", CANONICAL.ms1Area],
    ["PG.MaxLFQ", CANONICAL.pgMaxLfq],
    ["Evidence", CANONICAL.evidence],
    ["Quantity.Quality", CANONICAL.quantityQuality],
  ] as const) {
    const c = t.numeric(col);
    if (c) extras[label] = c[row]!;
  }

  let src: OpenArchive | null = null;
  try {
    src = await archiveFor(key.run);
  } catch (e) {
    return { key, extras, xic: null, reason: "archive-failed", detail: describe(e) };
  }
  if (!src) return { key, extras, xic: null, reason: "no-archive-for-run" };

  // The engine's own fragments when the report carries them: exact m/z, the
  // right ion series, and the ones it actually scored. Theoretical y-ions are
  // the fallback for reports written without --export-quant, and the UI says
  // which is in use.
  const measured = reportedFragments(session.report, row);
  const frags = measured?.slice(0, 6) ??
    fragmentsFor(key.sequence, key.charge, src.meta.spectra.ms2MzRange);
  const fragments = frags.map((f) => f.mz);
  const margin = 0.15;
  const t0 = performance.now();
  let xic;
  try {
    xic = await extractXic(src.archive, src.meta, src.peaks, {
      precursorMz: key.precursorMz,
      rtMin: key.rtStart - margin,
      rtMax: key.rtStop + margin,
      fragments,
      ppm: 20,
    });
  } catch (e) {
    // A decode failure must not take the window with it. WASM runs out of
    // memory as a Rust panic surfacing as `RuntimeError: unreachable`, which
    // an unguarded handler turns into a fatal main-process exception and a
    // dead application.
    return { key, extras, xic: null, reason: "extract-failed", detail: describe(e) };
  }
  const ms = performance.now() - t0;

  return {
    key,
    extras,
    reason: null,
    detail: null,
    xic: {
      rt: Array.from(xic.rt),
      traces: xic.traces.map((t) => Array.from(t)),
      fragments,
      labels: frags.map((f) => f.label),
      series: frags.map((f) => f.series),
      measured: !!measured,
      frames: xic.frames.length,
      rowGroups: xic.rowGroupsRead,
      rowsDecoded: xic.rowsDecoded,
      rowsScanned: xic.rowsScanned,
      archive: basename(src.path),
      ms,
    },
  };
});

/** A short, human-usable description of a failure — never a raw WASM trace. */
function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/unreachable|out of memory|allocation failed|Cannot enlarge memory/i.test(msg)) {
    return "The raw-data reader ran out of memory decoding this region. " +
      "This run is unusually dense; try a narrower retention-time window.";
  }
  if (/corrupt footer|Invalid Parquet/i.test(msg)) {
    return "The archive's peak facet could not be read — it may be truncated or still being written.";
  }
  return msg.split("\n")[0]!.slice(0, 200);
}


