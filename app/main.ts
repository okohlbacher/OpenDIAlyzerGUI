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
import os from "node:os";
import { loadReport, filterRows, seekKey, reportedFragments, CANONICAL,
  type ReportTable, type FilterSpec } from "../src/report.ts";
import { MzPeakArchive } from "../src/archive.ts";
import { buildMetadataIndex, framesCovering, type MetadataIndex } from "../src/spectra.ts";
import { PeakReader, extractXic, coelution, fragmentsFor, extractFramePeaks,
  heatmap, spectrum } from "../src/peaks.ts";
import { scanArchives, searchRoots, type Registry } from "../src/registry.ts";
import { measuredMs2Ppm, fragmentTolerancePpm } from "../src/stats.ts";
import { byProtein, byRun, type ProteinRow, type RunRow } from "../src/aggregate.ts";
import { sortIndices, applyColumnFilters, type Cell } from "../src/table.ts";
import { buildTree, flatten, idsAtLevel, type TreeNode, type FlatRow } from "../src/tree.ts";
import { detect, verify, plan, PRESETS, countFasta, estimateMemoryGb,
  type Install, type PresetId, type Stage } from "../src/engine.ts";
import { fromFiles, addColumn, setValue, validate, toTsv, fromTsv, matchRuns,
  REQUIRED, SUGGESTED, emptyInvestigation, type Sdrf, type Investigation }
  from "../src/sdrf.ts";

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

export type Grain = "precursors" | "proteins" | "runs" | "tree";

export interface TableView {
  sort?: { key: string; dir: "asc" | "desc" };
  /** Per-column filter text, keyed by the same column keys. */
  columns?: Record<string, string>;
}

/**
 * How each grain's columns are read.
 *
 * One place, so a sort and a filter on the same column can never disagree about
 * what that column contains — and so the header, the sorter and the filter all
 * speak the same keys.
 */
function readers(g: Grain): Record<string, (row: number) => Cell> {
  const t = session!.report;
  if (g === "proteins") {
    return {
      proteinGroup: (i) => proteins[i]?.proteinGroup,
      gene: (i) => proteins[i]?.genes,
      precursors: (i) => proteins[i]?.precursors,
      peptides: (i) => proteins[i]?.peptides,
      runs: (i) => proteins[i]?.runs,
      q: (i) => proteins[i]?.qValue,
      quant: (i) => proteins[i]?.quantity ?? undefined,
    };
  }
  if (g === "tree") {
    // The tree has its own order; sorting it would destroy the hierarchy. Only
    // filtering by label is meaningful, and it is handled by the global search.
    return {};
  }
  if (g === "runs") {
    return {
      run: (i) => runRows[i]?.name,
      precursors: (i) => runRows[i]?.precursors,
      peptides: (i) => runRows[i]?.peptides,
      proteins: (i) => runRows[i]?.proteins,
      q: (i) => runRows[i]?.medianQ,
      fwhm: (i) => runRows[i]?.medianFwhmSec,
      rt: (i) => runRows[i]?.rtRange[0],
    };
  }
  const num = (c: string) => {
    const col = t.numeric(c);
    return (i: number) => col?.[i];
  };
  return {
    seq: (i) => t.cell(CANONICAL.strippedSequence, i),
    z: num(CANONICAL.charge),
    mz: num(CANONICAL.precursorMz),
    rt: num(CANONICAL.rt),
    im: num(CANONICAL.im),
    q: num(CANONICAL.qValue),
    quant: num(CANONICAL.quantity),
    gene: (i) => t.cell(CANONICAL.genes, i) || t.cell(CANONICAL.proteinGroup, i),
  };
}

/** Precursor rows matching the current filter. Recomputed on every change. */
let visible: Uint32Array = new Uint32Array(0);
/** The current grain's rows. For precursors this mirrors `visible`. */
let grain: Grain = "precursors";
let proteins: ProteinRow[] = [];
let runRows: RunRow[] = [];
let tree: TreeNode[] = [];
let treeFlat: FlatRow[] = [];
let expanded = new Set<string>();



/**
 * Every grain aggregates the *filtered* precursor set, so the FDR slider moves
 * all three at once. Protein counts therefore always agree with the precursor
 * list they came from — which is the disagreement DIA-NN's matrices are famous
 * for (#1056).
 */
/** Row order within the current grain, after column filters and sorting. */
let order: Uint32Array = new Uint32Array(0);

function regrain(view: TableView = {}): void {
  proteins = grain === "proteins" ? byProtein(session!.report, visible) : [];
  runRows = grain === "runs" ? byRun(session!.report, visible) : [];

  if (grain === "tree") {
    tree = buildTree(session!.report, visible);
    // Expansion survives a re-filter where the node still exists, so moving the
    // FDR slider does not collapse everything the user opened.
    const alive = new Set<string>();
    const mark = (ns: readonly TreeNode[]) => {
      for (const n of ns) { if (expanded.has(n.id)) alive.add(n.id); mark(n.children); }
    };
    mark(tree);
    expanded = alive;
    treeFlat = flatten(tree, expanded);
    order = new Uint32Array(treeFlat.length);
    for (let i = 0; i < treeFlat.length; i++) order[i] = i;
    return;
  }
  tree = []; treeFlat = [];

  // For the coarse grains the index is into the aggregate array; for precursors
  // it is into `visible`, so the readers take a *report* row there.
  const n = grain === "precursors" ? visible.length
    : grain === "proteins" ? proteins.length : runRows.length;
  let idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = grain === "precursors" ? visible[i]! : i;

  const read = readers(grain);
  const cols = view.columns ?? {};
  const filters = Object.entries(cols)
    .filter(([k, v]) => v.trim() !== "" && read[k])
    .map(([k, v]) => ({ text: v, read: read[k]! }));
  if (filters.length) idx = applyColumnFilters(idx, filters);

  if (view.sort && read[view.sort.key]) {
    idx = sortIndices(idx, read[view.sort.key]!, view.sort.dir);
  }
  order = idx;
}

/** How many rows the current view has, after column filters. */
function viewCount(): number {
  return order.length;
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
  // ODIA_SMOKE_VIEW='{"sort":{"key":"q","dir":"desc"},"columns":{"gene":"ALB"}}'
  const expandTo = process.env.ODIA_SMOKE_EXPAND;
  if (expandTo) {
    await win.webContents.executeJavaScript(
      `(async () => { const r = await window.api.expandLevel(${JSON.stringify(expandTo)});
         state.total = r.total; const p = await window.api.page(0, WINDOW);
         state.rows = p.rows; paint(); })()`);
    await new Promise((r) => setTimeout(r, 3000));
    const n = await win.webContents.executeJavaScript("state.total");
    console.log("expanded rows:", n);
  }
  const view = process.env.ODIA_SMOKE_VIEW;
  if (view) {
    const v = JSON.parse(view);
    await win.webContents.executeJavaScript(
      `(async () => { state.sort = ${JSON.stringify(v.sort ?? null)};
         state.colFilters = ${JSON.stringify(v.columns ?? {})};
         await refresh(); })()`);
    await new Promise((r) => setTimeout(r, 2500));
    const probed = await win.webContents.executeJavaScript(
      `JSON.stringify({ total: state.total,
        first3: state.rows.slice(0,3).map(r => [r.seq ?? r.proteinGroup ?? r.run, r.q, r.gene]) })`);
    console.log("view:", probed);
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
  if (process.env.ODIA_SMOKE_SCROLL_EV) {
    await win.webContents.executeJavaScript(
      `document.getElementById("ev").scrollTop = ${Number(process.env.ODIA_SMOKE_SCROLL_EV)}`);
    await new Promise((r) => setTimeout(r, 700));
  }
  const img = await win.webContents.capturePage();
  const out = process.env.ODIA_SMOKE_OUT ?? "/tmp/odia-smoke.png";
  writeFileSync(out, img.toPNG());
  console.log("smoke capture written to", out);
  app.exit(0);
}

/**
 * Drives a scripted journey and records the state after each step.
 *
 * The regression harness. Structure and numbers only — never a screenshot
 * diff, which fails on font rendering and passes when a chart plots the wrong
 * data.
 */
async function uiScript(win: BrowserWindow, script: string): Promise<void> {
// ODIA_UI_SCRIPT=<file.json> drives a scripted sequence and dumps the
// resulting state as JSON — the regression harness. Each step is
// {do, ...args}; the probe after each step is what the test asserts on.

  const steps = JSON.parse(readFileSync(script, "utf8")) as Record<string, unknown>[];
  const trace: unknown[] = [];
  const out = process.env.ODIA_UI_OUT ?? "/tmp/odia-ui.json";
  // Write what we have on the way out whatever happens: a harness that hangs
  // silently is worse than one that fails, because there is nothing to read.
  const dump = () => writeFileSync(out, JSON.stringify(trace, null, 2));

  for (const [n, step] of steps.entries()) {
    const js = STEPS[String(step.do)];
    if (!js) { trace.push({ step: step.do, error: "unknown step" }); dump(); break; }
    console.log(`ui step ${n + 1}/${steps.length}: ${step.do}`);
    try {
      // A step that never settles must fail the run rather than stall it.
      await Promise.race([
        win.webContents.executeJavaScript(js(step)),
        new Promise((_r, rej) =>
          setTimeout(() => rej(new Error("step timed out")), Number(step.timeout ?? 60_000))),
      ]);
      await new Promise((r) => setTimeout(r, Number(step.settle ?? 900)));
      trace.push({
        step: step.do,
        state: JSON.parse(await win.webContents.executeJavaScript(PROBE)),
      });
    } catch (e) {
      trace.push({ step: step.do, error: describe(e) });
      dump();
      console.log(`ui step failed: ${describe(e)}`);
      app.exit(1);
      return;
    }
    dump();
  }
  console.log("ui trace written to", out);
  app.exit(0);

}

/**
 * The vocabulary the UI regression harness drives the app with.
 *
 * Deliberately expressed as the renderer's own functions rather than synthetic
 * clicks: a test that stops working because a button moved is testing the
 * layout, and a test that keeps passing because it clicked the wrong thing is
 * worse. These drive the same entry points the event handlers call.
 */
const STEPS: Record<string, (a: Record<string, unknown>) => string> = {
  open: (a) => `openSession(${JSON.stringify(a.report)})`,
  grain: (a) => `(async () => { state.grain = ${JSON.stringify(a.grain)};
    state.sort = null; state.colFilters = {}; state.sel = 0; await refresh(); })()`,
  select: (a) => `select(${Number(a.row)})`,
  fdr: (a) => `(async () => { state.fdr = ${Number(a.q)}; await refresh(); })()`,
  search: (a) => `(async () => { state.search = ${JSON.stringify(a.text)};
    state.sel = 0; await refresh(); })()`,
  run: (a) => `(async () => { state.run = ${a.run === null ? "undefined" : Number(a.run)};
    state.sel = 0; await refresh(); })()`,
  sort: (a) => `(async () => { state.sort = ${JSON.stringify(a.sort)}; await refresh(); })()`,
  colFilter: (a) => `(async () => { state.colFilters[${JSON.stringify(a.key)}] =
    ${JSON.stringify(a.text)}; state.sel = 0; await refresh(); })()`,
  expand: (a) => `(async () => { const r = await window.api.expandLevel(${JSON.stringify(a.level)});
    state.total = r.total; const p = await window.api.page(0, WINDOW);
    state.rows = p.rows; paint(); })()`,
  toggleFlag: (a) => `(async () => { document.getElementById(${JSON.stringify(a.id)}).checked =
    ${a.on ? "true" : "false"}; await refresh(); })()`,
  interrogate: (a) => `interrogate(state.sel, ${Number(a.run)})`,
  // Brushes to the first run that identified the selection, through the same
  // entry point the hit button's click handler uses.
  forRunProbe: () => `(async () => {
    const b = document.querySelector("#presence .prun.hit:not([disabled])");
    if (!b) throw new Error("no identified run in the presence strip to brush to");
    await showRunXic(state.sel, Number(b.dataset.run)); })()`,
  showAllSpectrumPeaks: () => `(async () => {
    const b = document.getElementById("specShowAll");
    if (!b) throw new Error("no show-all button — spectrum was not truncated for this selection");
    b.click(); })()`,
  screen: (a) => `showScreen(${JSON.stringify(a.screen)})`,
  projectFiles: (a) => `(async () => paintProject(
    await window.api.project.addFiles(${JSON.stringify(a.paths)})))()`,
  projectSet: (a) => `(async () => paintProject(await window.api.project.setValue(
    ${Number(a.row)}, ${JSON.stringify(a.column)}, ${JSON.stringify(a.value)})))()`,
  projectClear: () => `(async () => paintProject(await window.api.project.clear()))()`,
  projectColumn: (a) => `(async () => paintProject(
    await window.api.project.addColumn(${JSON.stringify(a.name)})))()`,
};

/**
 * What the harness records after each step.
 *
 * Structure and numbers only — never a screenshot diff. Pixel comparison fails
 * on font rendering and theme, and passes when a chart plots the wrong data.
 */
const PROBE = `JSON.stringify({
  grain: state.grain,
  total: state.total,
  loaded: state.rows.length,
  sel: state.sel,
  fdr: state.fdr,
  firstRows: state.rows.slice(0, 3).map(r =>
    r.seq ?? r.proteinGroup ?? r.run ?? r.label ?? null),
  evidenceTitle: document.querySelector("#ev .ev-title .s")?.textContent?.trim() ?? null,
  evidenceSource: document.getElementById("evsrc")?.textContent?.trim() ?? null,
  charts: document.querySelectorAll("#ev svg.chart").length,
  hasHeatmap: !!document.getElementById("heat"),
  presenceRuns: [...document.querySelectorAll("#presence .prun:not(.all)")].map(b =>
    b.className.replace("prun ", "")),
  runXicCharts: [...document.querySelectorAll("#ev .layer h3")]
    .filter(h => (h.textContent ?? "").trim().startsWith("Measured —")).length,
  // One <line> per spectrum peak, plus one for the axis baseline.
  specPeaksShown: Math.max(0, document.querySelectorAll("#specWrap svg.chart line").length - 1),
  specShowAllVisible: !!document.getElementById("specShowAll"),
  banners: [...document.querySelectorAll("#ev .banner")].map(b =>
    b.textContent.replace(/\\s+/g, " ").trim().slice(0, 90)),
  countText: document.getElementById("count")?.textContent?.trim() ?? null,
  screen: document.getElementById("project")?.hidden === false ? "project"
        : document.getElementById("setup")?.hidden === false ? "analyse" : "results",
  sdrfRows: document.querySelectorAll("#ptbody tr").length,
  sdrfCols: document.querySelectorAll("#pthead th").length,
  sdrfIssues: document.querySelectorAll("#pissues .issue").length,
  projectCount: document.getElementById("pcount")?.textContent?.trim() ?? null,
})`;

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

  // ODIA_SMOKE_SETUP shows screen 1 instead of opening a session.
  if (process.env.ODIA_SMOKE_SETUP) {
    win.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 2500));
      await win.webContents.executeJavaScript(
        `showScreen(${JSON.stringify(process.env.ODIA_SMOKE_SETUP)})`);
      await new Promise((r) => setTimeout(r, 1500));
      writeFileSync(process.env.ODIA_SMOKE_OUT ?? "/tmp/setup.png",
        (await win.webContents.capturePage()).toPNG());
      console.log("setup capture written");
      app.exit(0);
    });
    return;
  }

  const uiTarget = process.env.ODIA_UI_SCRIPT;
  if (uiTarget) {
    win.webContents.once("did-finish-load", () => void uiScript(win, uiTarget));
    return;
  }

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
  loadProject();
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

// ── Project (screen 0) ───────────────────────────────────────────────────────

/**
 * The experiment, held in main so every screen reads one copy.
 *
 * `docs/NAVIGATION.md`: nothing is entered twice. The run list *is* the SDRF's
 * rows, and once a report is open those rows join to it by run identity.
 */
let project: { sdrf: Sdrf; investigation: Investigation; path: string | null } = {
  sdrf: { columns: [...REQUIRED], rows: [] },
  investigation: emptyInvestigation(),
  path: null,
};

/**
 * The project survives the app closing.
 *
 * Annotation is typed by hand and is the one thing here that cannot be
 * recomputed: a report can be re-read and an archive re-converted, but the
 * organism someone looked up is gone if the window closes. So every mutation
 * writes through immediately rather than waiting for an explicit save — a Save
 * button people have not pressed yet is exactly how this data gets lost.
 */
const projectFile = () => join(app.getPath("userData"), "project.json");

function saveProject(): void {
  try {
    writeFileSync(projectFile(), JSON.stringify(project, null, 2));
  } catch (e) {
    // Never let a failed autosave break editing; the export path still works.
    console.error("could not autosave project:", describe(e));
  }
}

function loadProject(): void {
  try {
    const raw = readFileSync(projectFile(), "utf8");
    const p = JSON.parse(raw) as typeof project;
    // Tolerate a file written by an older build rather than discarding the
    // user's annotation because a field was added since.
    if (p && p.sdrf && Array.isArray(p.sdrf.columns) && Array.isArray(p.sdrf.rows)) {
      project = {
        sdrf: p.sdrf,
        investigation: { ...emptyInvestigation(), ...(p.investigation ?? {}) },
        path: p.path ?? null,
      };
    }
  } catch {
    // No project yet, or an unreadable one — start empty rather than fail.
  }
}

const projectState = () => ({
  columns: project.sdrf.columns,
  rows: project.sdrf.rows.map((r) => ({ path: r.path, values: r.values })),
  investigation: project.investigation,
  issues: validate(project.sdrf),
  suggested: SUGGESTED.filter((c) => !project.sdrf.columns.includes(c)),
  path: project.path,
});

ipcMain.handle("project:get", () => projectState());

ipcMain.handle("project:clear", () => {
  project = { sdrf: { columns: [...REQUIRED], rows: [] },
              investigation: emptyInvestigation(), path: null };
  saveProject();
  return projectState();
});

ipcMain.handle("project:addFiles", (_e, paths: string[]) => {
  project.sdrf = fromFiles(paths, project.sdrf);
  saveProject();
  return projectState();
});

ipcMain.handle("project:setValue", (_e, row: number, column: string, value: string) => {
  project.sdrf = setValue(project.sdrf, row, column, value);
  saveProject();
  return projectState();
});

ipcMain.handle("project:addColumn", (_e, name: string) => {
  project.sdrf = addColumn(project.sdrf, name);
  saveProject();
  return projectState();
});

ipcMain.handle("project:setInvestigation", (_e, inv: Partial<Investigation>) => {
  project.investigation = { ...project.investigation, ...inv };
  saveProject();
  return projectState();
});

ipcMain.handle("project:import", async () => {
  const r = await dialog.showOpenDialog({
    title: "Import SDRF",
    properties: ["openFile"],
    filters: [{ name: "SDRF", extensions: ["tsv", "sdrf", "txt"] }],
  });
  if (r.canceled || !r.filePaths[0]) return projectState();
  const file = r.filePaths[0];
  const dir = dirname(file);
  // Resolve each row's data file relative to the SDRF, which is where it is
  // most likely to sit; an unresolvable path is kept as written rather than
  // dropped, so the row survives and can be repointed.
  project.sdrf = fromTsv(readFileSync(file, "utf8"), (df) => {
    if (!df) return "";
    const local = join(dir, df);
    return existsSync(local) ? local : df;
  });
  project.path = file;
  saveProject();
  return projectState();
});

ipcMain.handle("project:export", async () => {
  const r = await dialog.showSaveDialog({
    title: "Export SDRF",
    defaultPath: project.path ?? "experiment.sdrf.tsv",
    filters: [{ name: "SDRF", extensions: ["tsv"] }],
  });
  if (r.canceled || !r.filePath) return null;
  writeFileSync(r.filePath, toTsv(project.sdrf));
  project.path = r.filePath;
  saveProject();
  return r.filePath;
});

/** SDRF annotation for the runs of the open report, joined by run identity. */
ipcMain.handle("project:forRuns", () => {
  if (!session) return null;
  const m = matchRuns(project.sdrf, session.report.runs);
  return session.report.runs.map((run) => ({
    run,
    values: m.get(run)?.values ?? null,
  }));
});

// ── Setup (screen 1) ─────────────────────────────────────────────────────────

/** What is installed, and what it can read here. */
ipcMain.handle("setup:engines", async (_e, extraPaths: string[] = []) => {
  const installs = await detect(extraPaths);
  return {
    installs,
    platform: process.platform,
    // DIA-NN ships no macOS build at all, so "not found" on darwin is a
    // property of the vendor rather than of this machine, and saying which is
    // the difference between a useful message and a wild goose chase.
    platformSupported: process.platform !== "darwin",
    cores: os.cpus().length,
    totalMemGb: Math.round(os.totalmem() / 2 ** 30),
  };
});

ipcMain.handle("setup:pickRuns", async () => {
  const r = await dialog.showOpenDialog({
    title: "Choose raw files or converted archives",
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [{ name: "MS data", extensions: ["raw", "d", "mzML", "dia", "mzpeak"] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("setup:pickFile", async (_e, kind: "fasta" | "lib" | "out") => {
  if (kind === "out") {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0]!;
  }
  const r = await dialog.showOpenDialog({
    title: kind === "fasta" ? "Choose a FASTA" : "Choose a spectral library",
    properties: ["openFile"],
    filters: kind === "fasta"
      ? [{ name: "FASTA", extensions: ["fasta", "fa", "fas", "faa"] }]
      : [{ name: "Library", extensions: ["parquet", "speclib", "tsv"] }],
  });
  return r.canceled ? null : r.filePaths[0]!;
});

/** Summarises dropped inputs — what they are, and what reading them will need. */
ipcMain.handle("setup:inspect", async (_e, paths: string[], enginePath?: string) => {
  const formats = new Set<string>();
  const runs: { path: string; name: string; format: string; bytes: number }[] = [];
  for (const p of paths) {
    const ext = /\.(raw|d|mzML|dia|mzpeak)$/i.exec(p)?.[1]?.toLowerCase() ?? "";
    if (!ext) continue;
    formats.add("." + ext);
    let bytes = 0;
    try {
      const st = statSync(p);
      bytes = st.isDirectory() ? dirSize(p) : st.size;
    } catch { /* unreadable inputs are reported by the requirement check */ }
    runs.push({ path: p, name: basename(p), format: "." + ext, bytes });
  }

  let requirements: Awaited<ReturnType<typeof verify>> = [];
  if (enginePath) {
    const installs = await detect([dirname(enginePath)]);
    const chosen = installs.find((i) => i.path === enginePath) ?? installs[0];
    if (chosen) requirements = await verify(chosen, [...formats]);
  }
  return { runs, formats: [...formats], requirements };
});

function dirSize(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    try { n += e.isDirectory() ? dirSize(p) : statSync(p).size; } catch { /* skip */ }
  }
  return n;
}

/**
 * Builds the plan and returns it without running anything.
 *
 * Previewable even with no engine installed, which matters: DIA-NN has no macOS
 * build, so on a Mac this screen can still assemble a plan to run elsewhere.
 */
ipcMain.handle("setup:plan", async (_e, job: {
  runs: string[]; fasta?: string; library?: string; outputDir: string;
  preset: PresetId; threads: number;
}) => {
  const stages = plan(job);
  let sequences: number | null = null;
  if (job.fasta) { try { sequences = await countFasta(job.fasta); } catch { /* reported below */ } }
  // Very rough: DIA-NN's own ~0.5 GB per million library precursors, and a
  // library-free search generates far more precursors than FASTA entries.
  const precursors = sequences ? sequences * 200 : 1e6;
  return {
    stages: stages.map((s: Stage) => ({ id: s.id, label: s.label, cfgPath: s.cfgPath,
                                        argv: s.argv, cfg: s.cfg, runs: s.runs })),
    sequences,
    estimatedMemGb: estimateMemoryGb(precursors, job.runs.length, false),
    hostMemGb: Math.round(os.totalmem() / 2 ** 30),
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, note: p.note })),
  };
});

ipcMain.handle("setup:presets", () =>
  Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, note: p.note })));

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
    mbr: usedMbr(reportPath),
    paired,
    found: registry.entries.length,
  };
});

/**
 * Whether the search used match-between-runs.
 *
 * This changes what the cohort glyph means. MBR re-searches with an empirical
 * library built from the first pass, and the report does **not** mark which
 * identifications came from that second pass — there is no "transferred" column.
 * So with MBR on, "5 of 6 runs" cannot distinguish five independent detections
 * from one detection and four transfers, and the UI has to say so rather than
 * let a reader infer reproducibility that was not measured.
 */
function usedMbr(reportPath: string): boolean | null {
  const log = join(dirname(reportPath),
    basename(reportPath).replace(/\.parquet$/, "") + ".log.txt");
  if (!existsSync(log)) return null;
  try {
    const text = readFileSync(log, "utf8");
    if (/\bMBR\b.*(enabled|will be used)|--reanalyse/i.test(text)) return true;
    // DIA-NN echoes its full command line; absence of the flag is a real answer.
    if (/diann[^\n]*--f\s/i.test(text)) return false;
    return null;
  } catch {
    return null;
  }
}

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
  (_e, spec: FilterSpec, offset = 0, limit = 200, g: Grain = "precursors",
   view: TableView = {}) => {
    if (!session) return { total: 0, rows: [], filterMs: 0, grain: g };
    const t0 = performance.now();
    grain = g;
    visible = filterRows(session.report, spec);
    regrain(view);
    const ms = performance.now() - t0;
    return { total: viewCount(), rows: page(offset, limit), filterMs: ms, grain };
  });

/** A window of the current filtered set. Pure paging — no predicate re-run. */
/** Opens or closes a node, then re-flattens. Cheap: only open subtrees walk. */
ipcMain.handle("tree:toggle", (_e, id: string, open?: boolean) => {
  if (!session) return { total: 0, rows: [] };
  const want = open ?? !expanded.has(id);
  if (want) expanded.add(id); else expanded.delete(id);
  treeFlat = flatten(tree, expanded);
  order = new Uint32Array(treeFlat.length);
  for (let i = 0; i < treeFlat.length; i++) order[i] = i;
  return { total: treeFlat.length };
});

/** Expand or collapse a whole level, as Skyline's Expand All > Precursors does. */
ipcMain.handle("tree:level", (_e, level: "protein" | "peptide" | "precursor" | "none") => {
  if (!session) return { total: 0 };
  expanded = level === "none" ? new Set()
    : idsAtLevel(tree, level === "protein" ? ["protein"]
      : level === "peptide" ? ["protein", "peptide"]
      : ["protein", "peptide", "precursor"]);
  treeFlat = flatten(tree, expanded);
  order = new Uint32Array(treeFlat.length);
  for (let i = 0; i < treeFlat.length; i++) order[i] = i;
  return { total: treeFlat.length };
});

ipcMain.handle("rows:page", (_e, offset: number, limit: number) => {
  if (!session) return { total: 0, rows: [] };
  return { total: viewCount(), rows: page(offset, limit) };
});

function page(offset: number, limit: number) {
  if (!session) return [];
  const t = session.report;
  const resolved = session.resolved;

  const slice = Array.from(order.subarray(offset, offset + limit));

  if (grain === "tree") {
    return slice.map((fi, n) => {
      const f = treeFlat[fi]!;
      return {
        k: offset + n, i: f.node.exemplar,
        level: f.node.level, id: f.node.id, depth: f.depth,
        expandable: f.expandable, expanded: f.expanded,
        label: f.node.label, detail: f.node.detail, counts: f.node.counts ?? "",
        seen: f.node.seen, runsTotal: f.node.total, runIndex: f.node.runIndex,
      };
    });
  }

  if (grain === "proteins") {
    return slice.map((gi, n) => proteins[gi]!).map((p, n) => ({
      k: offset + n, i: p.exemplar,
      proteinGroup: p.proteinGroup, gene: p.genes,
      precursors: p.precursors, observations: p.observations,
      peptides: p.peptides, runs: p.runs,
      q: p.qValue, quant: p.quantity, quantityNote: p.quantityNote,
    }));
  }
  if (grain === "runs") {
    return slice.map((gi) => runRows[gi]!).map((r, n) => ({
      k: offset + n, i: r.exemplar,
      run: r.name, runIndex: r.index,
      precursors: r.precursors, peptides: r.peptides, proteins: r.proteins,
      q: r.medianQ, fwhm: r.medianFwhmSec, quant: r.totalQuantity,
      rtRange: r.rtRange,
      archive: !!resolved.get(r.name),
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
  for (let n = 0; n < slice.length; n++) {
    const k = offset + n;
    const i = slice[n]!;
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
  // The *modified* sequence, as the tree uses. Keying on the stripped sequence
  // would merge a phosphopeptide with its unmodified form and report presence
  // for a molecule that was never looked for.
  const seqs = t.text(CANONICAL.modifiedSequence) ?? t.text(CANONICAL.strippedSequence);
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
    // A real NaN in the q column must not let the first-arriving row stay
    // locked in forever — see the identical fix in src/tree.ts.
    const better = !prev || (Number.isFinite(qv) && (!Number.isFinite(prev.q) || qv < prev.q));
    if (better) {
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
 * The measured chromatogram in one specific run where the peptide WAS found.
 *
 * The brushing counterpart of `evidence:interrogate`: same extraction, but this
 * run has its own identification, so nothing is borrowed. Uses that row's real
 * RT, m/z, IM and — via `reportedFragments` on that very row — the fragments the
 * engine scored *in this run*. That is the honest "show me this run" the cohort
 * exemplar cannot give, because the exemplar is whichever run scored best.
 */
ipcMain.handle("evidence:forRun", async (_e, k: number, runIndex: number) => {
  if (!session) return null;
  const t = session.report;
  const anchorRow = rowOf(k);
  if (anchorRow < 0) return null;
  const seqs = t.text(CANONICAL.modifiedSequence) ?? t.text(CANONICAL.strippedSequence);
  const zs = t.numeric(CANONICAL.charge);
  if (!seqs) return null;

  const seq = seqs[anchorRow]!;
  const z = zs?.[anchorRow] ?? 0;
  const target = t.runs[runIndex];
  if (!target) return null;

  // The peptidoform+charge's own row in this run — best q if it somehow repeats.
  const q = t.numeric(CANONICAL.qValue);
  let row = -1;
  let bestQ = Infinity;
  for (let i = 0; i < t.rowCount; i++) {
    if (seqs[i] !== seq || (zs && zs[i] !== z) || t.runOf[i] !== runIndex) continue;
    const qv = q?.[i] ?? Infinity;
    // A genuinely NaN q must not make an identified row vanish entirely — it
    // must still be picked as *a* row, just never preferred over a finite one.
    if (row < 0 || (Number.isFinite(qv) && (!Number.isFinite(bestQ) || qv < bestQ))) {
      bestQ = qv; row = i;
    }
  }
  if (row < 0) {
    // Not identified here — that is Interrogate's job, not this one.
    return { sequence: seq, charge: z, run: target, xic: null, reason: "not-in-this-run" };
  }

  const key = seekKey(t, row);
  if (!key) return { sequence: seq, charge: z, run: target, xic: null, reason: "no-seek-key" };

  let src: OpenArchive | null = null;
  try {
    src = await archiveFor(target);
  } catch (e) {
    return { sequence: seq, charge: z, run: target, xic: null,
             reason: "archive-failed", detail: describe(e) };
  }
  if (!src) return { sequence: seq, charge: z, run: target, xic: null, reason: "no-archive-for-run" };

  const measured = reportedFragments(t, row);
  const frags = measured?.slice(0, 6) ?? fragmentsFor(seq, key.charge, src.meta.spectra.ms2MzRange);
  const fragments = frags.map((f) => f.mz);
  const ppm = fragmentTolerancePpm(await measuredMs2Ppm(dirname(session.reportPath), target));
  const margin = 0.15;
  const t0 = performance.now();
  try {
    const xic = await extractXic(src.archive, src.meta, src.peaks, {
      precursorMz: key.precursorMz,
      rtMin: key.rtStart - margin, rtMax: key.rtStop + margin,
      fragments, ppm,
      imCenter: key.im ?? undefined,
    });
    const verdict = coelution(xic.traces);
    return {
      sequence: seq, charge: z, run: target, reason: null,
      measured: !!measured, qValue: key.qValue, rt: key.rt, precursorMz: key.precursorMz,
      xic: {
        rt: Array.from(xic.rt),
        traces: xic.traces.map((tr) => Array.from(tr)),
        fragments, labels: frags.map((f) => f.label), series: frags.map((f) => f.series),
        frames: xic.frames.length, rowGroups: xic.rowGroupsRead,
        rowsDecoded: xic.rowsDecoded, rowsScanned: xic.rowsScanned,
        archive: basename(src.path), verdict, ppm, ms: performance.now() - t0,
      },
    };
  } catch (e) {
    return { sequence: seq, charge: z, run: target, xic: null,
             reason: "extract-failed", detail: describe(e) };
  }
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
  const seqs = t.text(CANONICAL.modifiedSequence) ?? t.text(CANONICAL.strippedSequence);
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
  // Borrow the fragment list too, not just the retention time: the runs that
  // identified it know which ions the engine actually scored, and a theoretical
  // guess for a long peptide can miss them entirely. Found before first use —
  // declaring this below its use in `donorIm` was a temporal-dead-zone crash on
  // every interrogation.
  let donorRow = -1;
  for (let i = 0; i < t.rowCount; i++) {
    if (seqs[i] === seq && (!zs || zs[i] === z) && t.runOf[i] !== runIndex) { donorRow = i; break; }
  }
  const ims = t.numeric(CANONICAL.im);
  const donorIm = donorRow >= 0 && ims && Number.isFinite(ims[donorRow]!)
    ? ims[donorRow]! : null;
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

  const measured = donorRow >= 0 ? reportedFragments(t, donorRow) : null;
  const frags = measured?.slice(0, 6) ??
    fragmentsFor(seq, z, src.meta.spectra.ms2MzRange);
  const fragments = frags.map((f) => f.mz);
  const ppm = fragmentTolerancePpm(await measuredMs2Ppm(dirname(session.reportPath), target));
  const t0 = performance.now();
  try {
    const xic = await extractXic(src.archive, src.meta, src.peaks, {
      precursorMz: mz, rtMin: rt - margin, rtMax: rt + margin, fragments, ppm,
      // Borrowed like the RT: the runs that identified it measured the mobility.
      imCenter: donorIm ?? undefined,
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
        imWindow: xic.imWindow,
        rowsOutsideIm: xic.rowsOutsideIm,
        verdict,
        ppm,
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
  if (k < 0 || k >= order.length) return -1;
  const gi = order[k]!;
  if (grain === "tree") return treeFlat[gi]?.node.exemplar ?? -1;
  if (grain === "proteins") return proteins[gi]?.exemplar ?? -1;
  if (grain === "runs") return runRows[gi]?.exemplar ?? -1;
  return gi;   // precursors: `order` already holds report rows
}

/**
 * The apex frame's peaks, as a mobility heat map and a centroided spectrum.
 *
 * One extraction serves both: a spectrum is the frame's peaks against m/z, and
 * the heat map is the same points binned over (m/z, 1/K0). Binning happens in
 * the data layer because a diaPASEF frame is ~200,000 peaks and shipping those
 * to the renderer to bin would cost more than reading them.
 */
ipcMain.handle("evidence:frame", async (
  _e, k: number, mzWindow?: number, specLimit?: number,
) => {
  if (!session) return null;
  const row = rowOf(k);
  if (row < 0) return null;
  const key = seekKey(session.report, row);
  if (!key) return null;

  const src = await archiveFor(key.run).catch(() => null);
  if (!src) return { reason: "no-archive-for-run" };

  // The apex frame only. A mobility map of a whole RT window would average
  // away the separation it exists to show.
  const frames = framesCovering(src.meta, key.precursorMz, key.rt - 0.01, key.rt + 0.01);
  if (!frames.length) return { reason: "no-frame-at-apex" };

  const t0 = performance.now();
  try {
    const pts = await extractFramePeaks(src.archive, src.meta, src.peaks, frames.slice(0, 1));
    const half = mzWindow ?? 0;
    const hm = heatmap(pts, 220, 120,
      half > 0 ? [key.precursorMz - half, key.precursorMz + half] : undefined);
    const sp = spectrum(pts, 15, specLimit ?? 400);
    const frags = reportedFragments(session.report, row);
    return {
      reason: null,
      ms: performance.now() - t0,
      peaks: pts.mz.length,
      precursorMz: key.precursorMz,
      im: key.im,
      heat: hm && {
        cells: Array.from(hm.cells), nx: hm.nx, ny: hm.ny,
        mzRange: hm.mzRange, mobilityRange: hm.mobilityRange,
        mobilogram: Array.from(hm.mobilogram),
        maxIntensity: hm.maxIntensity,
      },
      spectrum: {
        mz: Array.from(sp.mz), intensity: Array.from(sp.intensity), total: sp.total,
      },
      fragments: (frags ?? []).slice(0, 12).map((f) => ({ label: f.label, mz: f.mz, series: f.series })),
    };
  } catch (e) {
    return { reason: "extract-failed", detail: describe(e) };
  }
});

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
  const ppm = fragmentTolerancePpm(await measuredMs2Ppm(dirname(session.reportPath), key.run));
  const margin = 0.15;
  const t0 = performance.now();
  let xic;
  try {
    xic = await extractXic(src.archive, src.meta, src.peaks, {
      precursorMz: key.precursorMz,
      rtMin: key.rtStart - margin,
      rtMax: key.rtStop + margin,
      fragments,
      ppm,
      // The engine's measured 1/K0 for this precursor. Without it the trace
      // sums the whole mobility ramp, which discards the separating dimension
      // diaPASEF exists to provide — measured at 73 % of the signal on this
      // cohort, and removing it *raised* fragment co-elution from 3 to 6.
      imCenter: key.im ?? undefined,
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
      imWindow: xic.imWindow,
      rowsOutsideIm: xic.rowsOutsideIm,
      ppm,
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
