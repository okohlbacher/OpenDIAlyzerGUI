/**
 * Electron main — window, and for now the data layer too.
 *
 * `docs/ARCHITECTURE.md` puts the data layer in a renderer Web Worker so it
 * runs unmodified in a browser. That is still the target. It lives in main for
 * this milestone because main is plain Node, so `parquet-wasm`, `openAsBlob`
 * and `fs` all work with no bundling at all — and the renderer talks to it by
 * message passing either way, so moving it is a swap rather than a rewrite.
 */
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { loadReport, filterRows, seekKey, CANONICAL, type ReportTable, type FilterSpec }
  from "../src/report.ts";
import { MzPeakArchive } from "../src/archive.ts";
import { buildMetadataIndex, type MetadataIndex } from "../src/spectra.ts";
import { PeakReader, extractXic } from "../src/peaks.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface Session {
  report: ReportTable;
  reportPath: string;
  archive: MzPeakArchive | null;
  meta: MetadataIndex | null;
  peaks: PeakReader | null;
  archivePath: string | null;
}
let session: Session | null = null;

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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1580,
    height: 940,
    minWidth: 1080,
    backgroundColor: "#100f0e",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { preload: join(here, "preload.cjs"), sandbox: false },
  });
  win.loadFile(join(here, "index.html"));
  const target = process.env.ODIA_SMOKE;
  if (target) win.webContents.once("did-finish-load", () => void smoke(win, target));
}

app.whenReady().then(() => {
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

/**
 * Finds a `.mzpeak` to pair with a report: alongside it, or one level up where
 * DIA-NN output usually sits next to the raw data it came from.
 */
function findArchive(reportPath: string): string | undefined {
  const dirs = [dirname(reportPath), join(dirname(reportPath), "..")];
  for (const d of dirs) {
    let names: string[];
    try { names = readdirSync(d); } catch { continue; }
    const hit = names.find((n) => n.endsWith(".mzpeak"));
    if (hit) return join(d, hit);
  }
  return undefined;
}

ipcMain.handle("session:open", async (_e, reportPath: string, archivePath?: string) => {
  archivePath ??= findArchive(reportPath);
  const t0 = performance.now();
  const report = await loadReport(reportPath);
  const loadMs = performance.now() - t0;

  // An archive is optional. Without one the table is fully usable and the
  // evidence pane says why it cannot draw — never a failure to open.
  let archive: MzPeakArchive | null = null;
  let meta: MetadataIndex | null = null;
  let peaks: PeakReader | null = null;
  let archiveErr: string | null = null;
  if (archivePath && existsSync(archivePath)) {
    try {
      archive = await MzPeakArchive.open(archivePath);
      meta = await buildMetadataIndex(archive);
      peaks = await PeakReader.open(archive);
    } catch (e) {
      archiveErr = String(e instanceof Error ? e.message : e);
      archive = null;
    }
  }

  session = { report, reportPath, archive, meta, peaks, archivePath: archivePath ?? null };
  return {
    name: basename(dirname(reportPath)),
    rowCount: report.rowCount,
    columns: report.columnNames.length,
    runs: report.runs,
    extra: report.extra.length,
    missing: report.missing,
    loadMs,
    archive: archive
      ? { path: basename(archivePath!), spectra: meta!.spectra.count, ims: !!archive.imsCalibration }
      : null,
    archiveErr,
  };
});

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

  if (!session.archive || !session.meta || !session.peaks) {
    return { key, extras, xic: null, reason: session.archivePath ? "archive-failed" : "no-archive" };
  }

  // Theoretical singly-charged y-ions from the sequence. A real library gives
  // measured fragments; this is the fallback the UI flags as such, and it is
  // also exactly what Interrogate has to do for a peptide nobody identified.
  const fragments = yIons(key.sequence).slice(0, 6);
  const margin = 0.15;
  const t0 = performance.now();
  const xic = await extractXic(session.archive, session.meta, session.peaks, {
    precursorMz: key.precursorMz,
    rtMin: key.rtStart - margin,
    rtMax: key.rtStop + margin,
    fragments,
    ppm: 20,
  });
  const ms = performance.now() - t0;

  return {
    key,
    extras,
    reason: null,
    xic: {
      rt: Array.from(xic.rt),
      traces: xic.traces.map((t) => Array.from(t)),
      fragments,
      frames: xic.frames.length,
      rowGroups: xic.rowGroupsRead,
      rowsDecoded: xic.rowsDecoded,
      rowsScanned: xic.rowsScanned,
      ms,
    },
  };
});

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
