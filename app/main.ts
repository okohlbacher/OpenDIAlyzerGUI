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
import { loadReport, filterRows, seekKey, CANONICAL, type ReportTable, type FilterSpec }
  from "../src/report.ts";
import { MzPeakArchive } from "../src/archive.ts";
import { buildMetadataIndex, type MetadataIndex } from "../src/spectra.ts";
import { PeakReader, extractXic } from "../src/peaks.ts";
import { scanArchives, searchRoots, type Registry } from "../src/registry.ts";

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

/** Row indices matching the current filter. Recomputed on every filter change. */
let visible: Uint32Array = new Uint32Array(0);

/**
 * `ODIA_SMOKE=<report.parquet>` opens that session, waits for first paint, writes
 * a PNG next to it and exits. Verifying a UI means looking at it; this is the
 * cheapest way to do that without a human at the keyboard.
 */
async function smoke(win: BrowserWindow, reportPath: string): Promise<void> {
  await win.webContents.executeJavaScript(
    `openSession(${JSON.stringify(reportPath)}).then(() => {
       const k = Math.min(3, state.rows.length - 1);
       if (k >= 0) select(k);
     })`);
  await new Promise((r) => setTimeout(r, 4000));
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

ipcMain.handle("rows:filter", (_e, spec: FilterSpec, offset = 0, limit = 300) => {
  if (!session) return { total: 0, rows: [] };
  const t0 = performance.now();
  visible = filterRows(session.report, spec);
  const ms = performance.now() - t0;

  const t = session.report;
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
  for (let k = offset; k < Math.min(offset + limit, visible.length); k++) {
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
  return { total: visible.length, rows, filterMs: ms };
});

ipcMain.handle("evidence:for", async (_e, k: number) => {
  if (!session || k < 0 || k >= visible.length) return null;
  const row = visible[k]!;
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

  // Theoretical singly-charged y-ions from the sequence. A real library gives
  // measured fragments; this is the fallback the UI flags as such, and it is
  // also exactly what Interrogate has to do for a peptide nobody identified.
  const fragments = yIons(key.sequence).slice(0, 6);
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

/** Monoisotopic residue masses, in Da. */
const AA: Record<string, number> = {
  G: 57.02146, A: 71.03711, S: 87.03203, P: 97.05276, V: 99.06841,
  T: 101.04768, C: 160.03065, L: 113.08406, I: 113.08406, N: 114.04293,
  D: 115.02694, Q: 128.05858, K: 128.09496, E: 129.04259, M: 131.04049,
  H: 137.05891, F: 147.06841, R: 156.10111, Y: 163.06333, W: 186.07931,
};
const H2O = 18.010565;
const PROTON = 1.007276;

/** Singly-charged y-ion m/z values, longest first. */
function yIons(seq: string): number[] {
  const out: number[] = [];
  let sum = H2O;
  for (let i = seq.length - 1; i >= 1; i--) {
    const m = AA[seq[i]!];
    if (m === undefined) return out.reverse();
    sum += m;
    out.push(sum + PROTON);
  }
  return out.reverse();
}
