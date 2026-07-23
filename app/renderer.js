"use strict";
/**
 * View layer. Owns no data — every number here came over IPC from the data
 * layer, which is why the same file will work unchanged when that layer moves
 * into a Web Worker.
 */
const $ = (id) => document.getElementById(id);
const FDR_STOPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.5];

const state = {
  open: false,
  fdr: 0.01,
  run: undefined,
  search: "",
  sel: 0,
  total: 0,
  rows: [],
  pending: null,
};

// ── session ──────────────────────────────────────────────────────────────────

async function openSession(reportPath, archivePath) {
  const s = await window.api.open(reportPath, archivePath);
  state.open = true;
  state.sel = 0;
  state.run = undefined;

  $("sessionName").textContent = s.name;
  $("sessionCtx").textContent =
    `${s.runs.length} runs · ${s.rowCount.toLocaleString()} rows · ` +
    `${s.columns} columns · loaded in ${s.loadMs.toFixed(0)} ms`;

  const chip = $("archiveChip");
  chip.hidden = false;
  if (s.archive) {
    chip.textContent = `${s.archive.path} · ${s.archive.spectra.toLocaleString()} spectra` +
      (s.archive.ims ? " · IM" : "");
    chip.style.borderColor = "var(--good)";
    chip.style.color = "var(--good)";
  } else {
    chip.textContent = s.archiveErr ? "archive failed to open" : "no .mzpeak — table only";
    chip.style.borderColor = "var(--warn)";
    chip.style.color = "var(--warn)";
  }

  $("sessionCard").hidden = false;
  $("sessionDl").innerHTML = [
    ["rows", s.rowCount.toLocaleString()],
    ["columns", `${s.columns}`],
    ["unrecognised", `${s.extra}`],
    ["missing", s.missing.length ? String(s.missing.length) : "none"],
  ].map(([k, v]) => `<dt>${k}</dt><dd class="mono">${v}</dd>`).join("");

  $("runs").innerHTML =
    `<li role="option" data-i="-1" aria-selected="true">
       <span class="dot ok"></span><span>All runs</span></li>` +
    s.runs.map((r, i) =>
      `<li role="option" data-i="${i}" aria-selected="false" title="${esc(r)}">
         <span class="dot ok"></span><span class="mono">${esc(shortRun(r))}</span></li>`).join("");

  await refresh();
}

/**
 * Run names here look like `run-01.d`.
 * The part that identifies the sample is the `S08` group near the front, so
 * elide from the middle rather than trimming both ends evenly.
 */
const shortRun = (r) => {
  const base = r.split(/[\\/]/).pop().replace(/\.d$/, "");
  if (base.length <= 24) return base;
  return base.slice(0, 14) + "…" + base.slice(-6);
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── table ────────────────────────────────────────────────────────────────────

async function refresh() {
  if (!state.open) return;
  const r = await window.api.filter({
    maxQValue: state.fdr,
    hideDecoys: $("hidedecoy").checked,
    proteotypicOnly: $("proteotypic").checked,
    run: state.run,
    search: state.search || undefined,
  }, 0, 400);

  state.total = r.total;
  state.rows = r.rows;
  if (state.sel >= r.rows.length) state.sel = Math.max(0, r.rows.length - 1);

  $("thead").innerHTML =
    `<tr><th>Peptide</th><th class="num">z</th><th class="num">m/z</th>
      <th class="num">RT</th><th class="num">1/K0</th><th class="num">q</th>
      <th class="num">Quantity</th><th>Gene</th></tr>`;

  $("tbody").innerHTML = r.rows.map((row) => {
    const cls = row.q <= 0.001 ? "ok" : row.q <= 0.01 ? "mid" : "bad";
    return `<tr data-k="${row.k}" class="${row.k === state.sel ? "sel" : ""}"
        aria-selected="${row.k === state.sel}">
      <td class="seq-cell" title="${esc(row.seq)}"><span class="mono seq">${esc(row.seq)}</span></td>
      <td class="num mono">${row.z}+</td>
      <td class="num mono">${row.mz.toFixed(3)}</td>
      <td class="num mono">${row.rt.toFixed(2)}</td>
      <td class="num mono">${row.im ? row.im.toFixed(3) : "—"}</td>
      <td class="num mono qv ${cls}">${fmtQ(row.q)}</td>
      <td class="num mono">${row.quant ? row.quant.toExponential(1) : "—"}</td>
      <td>${esc(row.gene)}</td></tr>`;
  }).join("");

  const shown = Math.min(r.rows.length, r.total);
  $("count").textContent =
    `${shown.toLocaleString()} of ${r.total.toLocaleString()} · re-filtered in ${r.filterMs.toFixed(1)} ms`;

  await showEvidence();
}

const fmtQ = (q) =>
  !Number.isFinite(q) ? "—" : q < 1e-3 ? q.toExponential(0) : q.toFixed(4);

// ── evidence ─────────────────────────────────────────────────────────────────

async function showEvidence() {
  const ev = $("ev");
  if (!state.rows.length) {
    ev.innerHTML = `<div class="empty"><p>Nothing matches this filter.</p></div>`;
    $("evsrc").textContent = "";
    return;
  }
  ev.classList.add("busy");
  const token = (state.pending = Symbol());
  const e = await window.api.evidence(state.sel);
  if (token !== state.pending) return; // a newer selection won
  ev.classList.remove("busy");
  if (!e) { ev.innerHTML = ""; return; }

  const k = e.key;
  const meta = [
    ["q-value", fmtQ(k.qValue)],
    ["apex RT", k.rt.toFixed(2)],
    ["window", `${(k.rtStop - k.rtStart).toFixed(3)} min`],
    ["1/K0", k.im ? k.im.toFixed(4) : "—"],
  ];

  let body = `
    <div class="ev-title">
      <span class="s mono">${esc(k.sequence)}</span>
      <span class="z mono">${k.charge}+ · ${k.precursorMz.toFixed(4)} m/z</span>
    </div>
    <div class="ev-meta">${meta.map(([a, b]) =>
      `<div><div class="k">${a}</div><div class="v mono">${b}</div></div>`).join("")}</div>`;

  if (!e.xic) {
    body += `<div class="banner" style="margin-top:14px"><div>
      ${e.reason === "no-archive"
        ? "<b>No .mzpeak open.</b> The table is fully usable without one — but the drilldown is a live read into raw data, so it needs the archive for this run."
        : "<b>The archive could not be opened.</b> The table is unaffected."}
      </div></div>`;
    $("evsrc").textContent = "table only";
  } else {
    const x = e.xic;
    const sig = x.traces.some((t) => t.some((v) => v > 0));
    body += `
      <div class="layer">
        <div class="layer-head"><h3>Fragment ion chromatograms</h3>
          <span class="hint">${x.frames} frames · ${x.rowGroups} row groups</span></div>
        ${chart(x)}
        <div class="legend">${x.fragments.map((f, i) =>
          `<span><i style="background:${ionColour(i)}"></i>y${x.fragments.length - i} ${f.toFixed(2)}</span>`).join("")}</div>
        <p class="note-inline">
          Extracted from raw data in <b>${x.ms.toFixed(0)} ms</b> —
          ${(x.rowsDecoded / 1e6).toFixed(2)} M rows decoded,
          ${(x.rowsScanned / 1e3).toFixed(0)}k touched.
          Fragments are theoretical y-ions from the sequence.
          ${sig ? "" : '<span class="err">No signal in this window.</span>'}
        </p>
      </div>`;
    $("evsrc").textContent = `from raw · ${x.ms.toFixed(0)} ms`;
  }

  const rows = Object.entries(e.extras).filter(([, v]) => Number.isFinite(v));
  if (rows.length) {
    body += `<div class="layer"><div class="layer-head"><h3>Reported by the engine</h3></div>
      <div class="ev-meta" style="margin:0">${rows.map(([a, v]) =>
        `<div><div class="k">${esc(a)}</div><div class="v mono">${
          Math.abs(v) >= 1e4 ? v.toExponential(1) : v.toFixed(3)}</div></div>`).join("")}</div></div>`;
  }
  ev.innerHTML = body;
}

const ionColour = (i) => [
  "var(--ion-y)", "var(--ion-y)", "var(--ion-y)",
  "var(--ion-b)", "var(--ion-b)", "var(--ion-b)",
][i % 6];

function chart(x) {
  const W = 420, H = 140, L = 38, B = 20, T = 8, R = 6;
  const n = x.rt.length;
  if (n < 2) return `<p class="note-inline err">Too few points to draw.</p>`;
  const rt0 = x.rt[0], rt1 = x.rt[n - 1];
  let max = 0;
  for (const t of x.traces) for (const v of t) if (v > max) max = v;
  if (max <= 0) max = 1;

  const px = (r) => L + ((r - rt0) / (rt1 - rt0 || 1)) * (W - L - R);
  const py = (v) => T + (1 - v / max) * (H - T - B);

  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const gx = L + (i / 4) * (W - L - R);
    const rv = rt0 + ((rt1 - rt0) * i) / 4;
    grid += `<line x1="${gx.toFixed(1)}" y1="${T}" x2="${gx.toFixed(1)}" y2="${H - B}"
        stroke="var(--line-soft)"/>
      <text x="${gx.toFixed(1)}" y="${H - 6}" fill="var(--muted)" font-size="8.5"
        text-anchor="middle" font-family="ui-monospace,Menlo,monospace">${rv.toFixed(2)}</text>`;
  }

  const paths = x.traces.map((t, i) => {
    let d = "";
    for (let j = 0; j < n; j++) d += (j ? "L" : "M") + px(x.rt[j]).toFixed(1) + " " + py(t[j]).toFixed(1);
    return `<path d="${d}" fill="none" stroke="${ionColour(i)}" stroke-width="1.35"
      stroke-linejoin="round" opacity=".92"/>`;
  }).join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Fragment ion chromatograms">
    ${grid}
    <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="var(--line)"/>
    <text x="2" y="${T + 8}" fill="var(--muted)" font-size="8.5"
      font-family="ui-monospace,Menlo,monospace">${max.toExponential(0)}</text>
    <text x="${W - R}" y="${H - 6}" fill="var(--muted)" font-size="8.5" text-anchor="end"
      font-family="ui-monospace,Menlo,monospace">min</text>
    ${paths}</svg>`;
}

// ── events ───────────────────────────────────────────────────────────────────

$("openBtn").addEventListener("click", async () => {
  const p = await window.api.pick();
  if (!p) return;
  // Main pairs the report with a sibling .mzpeak on its own.
  await openSession(p);
});

$("fdr").addEventListener("input", (e) => {
  state.fdr = FDR_STOPS[Math.round((e.target.value / 100) * (FDR_STOPS.length - 1))];
  $("fdrOut").textContent = state.fdr.toFixed(3);
  refresh();
});
$("proteotypic").addEventListener("change", refresh);
$("hidedecoy").addEventListener("change", refresh);

$("runs").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  const i = Number(li.dataset.i);
  state.run = i < 0 ? undefined : i;
  state.sel = 0;
  for (const el of $("runs").children) el.setAttribute("aria-selected", el === li);
  refresh();
});

let searchTimer;
$("q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => { state.search = v; state.sel = 0; refresh(); }, 140);
});

$("tbody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  select(Number(tr.dataset.k));
});

function select(k) {
  if (k < 0 || k >= state.rows.length) return;
  state.sel = k;
  for (const tr of $("tbody").children) {
    const on = Number(tr.dataset.k) === k;
    tr.classList.toggle("sel", on);
    tr.setAttribute("aria-selected", String(on));
    if (on) tr.scrollIntoView({ block: "nearest" });
  }
  showEvidence();
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); $("q").focus(); return; }
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowDown") { e.preventDefault(); select(state.sel + 1); }
  if (e.key === "ArrowUp") { e.preventDefault(); select(state.sel - 1); }
});

$("fdrOut").textContent = state.fdr.toFixed(3);
