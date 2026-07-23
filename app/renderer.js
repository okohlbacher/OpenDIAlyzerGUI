"use strict";
/**
 * View layer. Owns no data — every number here came over IPC from the data
 * layer, which is why the same file will work unchanged when that layer moves
 * into a Web Worker.
 */
const $ = (id) => document.getElementById(id);
const FDR_STOPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.5];

// Virtualised list. A cohort report is hundreds of thousands of rows and the
// whole point of the FDR slider is to move through them, so the table renders a
// window and pads it with two spacer rows rather than materialising the set.
const ROW_H = 29;      // must match the CSS; the maths depends on it
const WINDOW = 120;    // rows rendered
const OVERSCAN = 40;   // rows kept beyond the viewport, so a nudge never blanks

const state = {
  open: false,
  grain: "precursors",
  sort: null,          // {key, dir}
  colFilters: {},      // key -> text
  fdr: 0.01,
  run: undefined,
  search: "",
  sel: 0,          // absolute index into the filtered set
  total: 0,
  rows: [],        // the rendered window
  first: 0,        // absolute index of rows[0]
  pending: null,
  paging: false,
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

  // Raw-data coverage is a property of the experiment, not a yes/no for the
  // session: some runs may be paired and others not, and the UI should say which.
  const chip = $("archiveChip");
  chip.hidden = false;
  const n = s.runs.length;
  chip.textContent = s.paired === 0
    ? `no raw data — table only`
    : `raw data for ${s.paired}/${n} runs`;
  const tone = s.paired === 0 ? "warn" : s.paired === n ? "good" : "warn";
  chip.style.borderColor = `var(--${tone})`;
  chip.style.color = `var(--${tone})`;
  chip.title = `scanned in ${s.scanMs.toFixed(0)} ms · ${s.found} archive(s) found`;

  $("sessionCard").hidden = false;
  $("sessionDl").innerHTML = [
    ["rows", s.rowCount.toLocaleString()],
    ["columns", `${s.columns}`],
    ["unrecognised", `${s.extra}`],
    ["missing", s.missing.length ? String(s.missing.length) : "none"],
    ["raw data", `${s.paired}/${s.runs.length}`],
  ].map(([k, v]) => `<dt>${k}</dt><dd class="mono">${v}</dd>`).join("");

  $("runs").innerHTML =
    `<li role="option" data-i="-1" aria-selected="true">
       <span class="dot ok"></span><span>All runs</span></li>` +
    s.runs.map((r, i) =>
      `<li role="option" data-i="${i}" aria-selected="false"
           title="${esc(r.name)}${r.archive ? "\nraw: " + esc(r.archive) : "\nno .mzpeak found"}">
         <span class="dot ${r.archive ? "ok" : "warnd"}"></span>
         <span class="mono">${esc(shortRun(r.name))}</span></li>`).join("");

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

const currentFilter = () => ({
  maxQValue: state.fdr,
  hideDecoys: $("hidedecoy").checked,
  proteotypicOnly: $("proteotypic").checked,
  run: state.run,
  search: state.search || undefined,
});

async function refresh() {
  if (!state.open) return;
  const r = await window.api.filter(currentFilter(), 0, WINDOW, state.grain,
    { sort: state.sort, columns: state.colFilters });

  state.total = r.total;
  state.rows = r.rows;
  state.first = 0;
  state.filterMs = r.filterMs;
  if (state.sel >= state.total) state.sel = Math.max(0, state.total - 1);
  $("scroller").scrollTop = 0;

  $("thead").innerHTML = headHtml();
  wireHeader();
  if (state.grain === "tree") {
    $("thead").querySelectorAll("button.lvl").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const r = await window.api.expandLevel(b.dataset.level);
        state.total = r.total; state.first = 0; state.sel = 0;
        $("scroller").scrollTop = 0;
        const p = await window.api.page(0, WINDOW);
        state.rows = p.rows; paint();
      }));
  }
  paint();
  scheduleEvidence();
}

/**
 * Columns, once. The header, the sort key and the filter box all read from
 * here, so they cannot drift apart — and `hint` teaches the filter syntax in
 * the place it is used rather than in documentation nobody opens.
 */
const COLUMNS = {
  tree: [{ key: "tree", label: "Targets", hint: "" }],
  precursors: [
    { key: "seq", label: "Peptide", hint: "text" },
    { key: "z", label: "z", num: true, hint: "2" },
    { key: "mz", label: "m/z", num: true, hint: "400-600" },
    { key: "rt", label: "RT", num: true, hint: ">10" },
    { key: "im", label: "1/K0", num: true, hint: "" },
    { key: "q", label: "q", num: true, hint: "<0.01" },
    { key: "quant", label: "Quantity", num: true, hint: ">1e4" },
    { key: "gene", label: "Gene", hint: "text" },
  ],
  proteins: [
    { key: "proteinGroup", label: "Protein group", hint: "text" },
    { key: "gene", label: "Genes", hint: "text" },
    { key: "precursors", label: "Precursors", num: true, hint: ">10" },
    { key: "peptides", label: "Peptides", num: true, hint: "" },
    { key: "runs", label: "Runs", num: true, hint: "6" },
    { key: "q", label: "q", num: true, hint: "<0.01" },
    { key: "quant", label: "Quantity", num: true, hint: "" },
  ],
  runs: [
    { key: "run", label: "Run", hint: "text" },
    { key: "precursors", label: "Precursors", num: true, hint: "" },
    { key: "peptides", label: "Peptides", num: true, hint: "" },
    { key: "proteins", label: "Proteins", num: true, hint: "" },
    { key: "q", label: "Median q", num: true, hint: "" },
    { key: "fwhm", label: "FWHM", num: true, hint: "" },
    { key: "rt", label: "RT range", num: true, hint: "" },
    { key: "archive", label: "Raw", hint: "" },
  ],
};

function headHtml() {
  if (state.grain === "tree") {
    // Sorting would destroy the hierarchy, so the header carries the level
    // controls instead — Skyline's Expand All > Precursors, which is the only
    // way to work a tree of 8,000 proteins without clicking 8,000 times.
    return `<tr><th colspan="2" style="font-weight:500">
        expand
        <button class="linkish lvl" data-level="none">none</button>
        <button class="linkish lvl" data-level="protein">proteins</button>
        <button class="linkish lvl" data-level="peptide">peptides</button>
        <button class="linkish lvl" data-level="precursor">precursors</button>
      </th><th class="num" style="font-weight:500">runs</th></tr>`;
  }
  const cols = COLUMNS[state.grain];
  const th = cols.map((c) => {
    const sorted = state.sort?.key === c.key;
    const arrow = sorted ? (state.sort.dir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="${c.num ? "num " : ""}sortable${sorted ? " sorted" : ""}"
      data-sort="${c.key}" title="click to sort">${esc(c.label)}${arrow}</th>`;
  }).join("");
  const filt = cols.map((c) => {
    const v = state.colFilters[c.key] ?? "";
    return `<th class="filt"><input data-filter="${c.key}" value="${esc(v)}"
      placeholder="${esc(c.hint)}" aria-label="filter ${esc(c.label)}"
      class="${v ? "on" : ""}"></th>`;
  }).join("");
  return `<tr>${th}</tr><tr class="filters">${filt}</tr>`;
}

/** One row of the current grain. */
/**
 * The cohort glyph: n of N runs, as filled segments plus the fraction.
 *
 * Shape and text, never colour alone. Skyline shipped colour-only red/green
 * dots and needed until December 2025 to retrofit distinct shapes.
 */
function cohortGlyph(seen, total) {
  if (!total || total < 1) return "";
  const seg = [];
  for (let i = 0; i < Math.min(total, 12); i++) {
    seg.push(`<i class="seg ${i < seen ? "on" : ""}"></i>`);
  }
  const cls = seen === total ? "all" : seen === 0 ? "none" : "some";
  return `<span class="cohort ${cls}" title="identified in ${seen} of ${total} runs at the current threshold">
    ${seg.join("")}<span class="frac mono">${seen}/${total}</span></span>`;
}

function treeRowHtml(row) {
  const sel = row.k === state.sel;
  const pad = 6 + row.depth * 15;
  const twist = row.expandable
    ? `<span class="twist" data-toggle="${esc(row.id)}">${row.expanded ? "▾" : "▸"}</span>`
    : `<span class="twist"></span>`;
  return `<tr data-k="${row.k}" data-level="${row.level}" class="${sel ? "sel" : ""}"
      aria-selected="${sel}">
    <td class="tcell" style="padding-left:${pad}px">
      ${twist}<span class="tlabel ${row.level}" ${row.level === "run" ? `title="${esc(row.label)}"` : ""}
        >${esc(row.level === "run" ? shortRun(row.label) : row.label)}</span>
      ${row.detail ? `<span class="tdetail">${esc(row.detail)}</span>` : ""}
    </td>
    <td class="tcounts">${esc(row.counts)}</td>
    <td class="num">${row.level === "run" ? "" : cohortGlyph(row.seen, row.runsTotal)}</td>
  </tr>`;
}

function rowHtml(row) {
  if (state.grain === "tree") return treeRowHtml(row);
  const sel = row.k === state.sel;
  const open = `<tr data-k="${row.k}" class="${sel ? "sel" : ""}" aria-selected="${sel}">`;
  const qcls = row.q <= 0.001 ? "ok" : row.q <= 0.01 ? "mid" : "bad";

  if (state.grain === "proteins") {
    return open +
      `<td class="seq-cell" title="${esc(row.proteinGroup)}"><span class="mono seq">${esc(row.proteinGroup)}</span></td>
       <td>${esc(row.gene)}</td>
       <td class="num mono">${row.precursors}</td>
       <td class="num mono">${row.peptides}</td>
       <td class="num mono">${row.runs}</td>
       <td class="num mono qv ${qcls}">${fmtQ(row.q)}</td>
       <td class="num mono" title="${row.quantityIsSum ? "summed precursor quantity — no MaxLFQ" : "MaxLFQ"}">${
         row.quant ? row.quant.toExponential(1) : "—"}${row.quantityIsSum ? "*" : ""}</td></tr>`;
  }
  if (state.grain === "runs") {
    return open +
      `<td class="seq-cell" title="${esc(row.run)}"><span class="mono seq">${esc(shortRun(row.run))}</span></td>
       <td class="num mono">${row.precursors.toLocaleString()}</td>
       <td class="num mono">${row.peptides.toLocaleString()}</td>
       <td class="num mono">${row.proteins.toLocaleString()}</td>
       <td class="num mono">${fmtQ(row.q)}</td>
       <td class="num mono">${Number.isFinite(row.fwhm) ? row.fwhm.toFixed(1) + " s" : "—"}</td>
       <td class="num mono">${row.rtRange[0].toFixed(0)}–${row.rtRange[1].toFixed(0)}</td>
       <td><span class="dot ${row.archive ? "ok" : "warnd"}"></span></td></tr>`;
  }
  return open +
    `<td class="seq-cell" title="${esc(row.seq)}"><span class="mono seq">${esc(row.seq)}</span></td>
     <td class="num mono">${row.z}+</td>
     <td class="num mono">${row.mz.toFixed(3)}</td>
     <td class="num mono">${row.rt.toFixed(2)}</td>
     <td class="num mono">${row.im ? row.im.toFixed(3) : "—"}</td>
     <td class="num mono qv ${qcls}">${fmtQ(row.q)}</td>
     <td class="num mono">${row.quant ? row.quant.toExponential(1) : "—"}</td>
     <td>${esc(row.gene)}</td></tr>`;
}

/** Renders the current window, padded above and below to the full scroll height. */
function paint() {
  const before = state.first * ROW_H;
  const after = Math.max(0, (state.total - state.first - state.rows.length) * ROW_H);

  const cols = state.grain === "tree" ? 3 : COLUMNS[state.grain].length;
  $("tbody").innerHTML =
    (before ? `<tr class="spacer" style="height:${before}px"><td colspan="${cols}"></td></tr>` : "") +
    state.rows.map(rowHtml).join("") +
    (after ? `<tr class="spacer" style="height:${after}px"><td colspan="${cols}"></td></tr>` : "");

  $("count").textContent = state.total
    ? `${state.grain === "precursors" ? "row" : state.grain === "proteins" ? "protein" : "run"} ` +
      `${(state.sel + 1).toLocaleString()} of ${state.total.toLocaleString()}` +
      (state.filterMs !== undefined ? ` · filtered in ${state.filterMs.toFixed(1)} ms` : "")
    : "nothing matches this filter";
}

/** Loads the window covering `first`, if it is not already loaded. */
async function ensureWindow(first) {
  const want = Math.max(0, Math.min(first, Math.max(0, state.total - WINDOW)));
  if (want === state.first && state.rows.length) return;
  if (state.paging) return;
  state.paging = true;
  try {
    const r = await window.api.page(want, WINDOW);
    state.total = r.total;
    state.rows = r.rows;
    state.first = want;
    paint();
  } finally {
    state.paging = false;
  }
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
  let e;
  try {
    e = await window.api.evidence(state.sel);
  } catch (err) {
    // A rejected handler must not leave the pane silently blank — that reads as
    // "no evidence" when it means "we failed to look".
    ev.classList.remove("busy");
    ev.innerHTML = `<div class="banner"><div><b>Evidence failed.</b>
      ${esc(String(err?.message ?? err))}</div></div>`;
    $("evsrc").textContent = "error";
    return;
  }
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

  // In a coarser grain the evidence is still a precursor's — say whose, or the
  // panel silently swaps a protein for a peptide.
  const row = state.rows.find((r) => r.k === state.sel);
  const context = state.grain === "proteins" && row
    ? `<p class="note-inline" style="margin:0 0 8px">Best precursor of
        <span class="mono">${esc(row.proteinGroup)}</span>${row.gene ? " · " + esc(row.gene) : ""},
        ${row.precursors} precursors across ${row.runs} run${row.runs === 1 ? "" : "s"}</p>`
    : state.grain === "runs" && row
      ? `<p class="note-inline" style="margin:0 0 8px">First precursor of
          <span class="mono">${esc(shortRun(row.run))}</span> —
          ${row.precursors.toLocaleString()} precursors, ${row.proteins.toLocaleString()} proteins</p>`
      : "";

  let body = `
    ${context}
    <div class="ev-title">
      <span class="s mono">${esc(k.sequence)}</span>
      <span class="z mono">${k.charge}+ · ${k.precursorMz.toFixed(4)} m/z</span>
    </div>
    <div class="ev-meta">${meta.map(([a, b]) =>
      `<div><div class="k">${a}</div><div class="v mono">${b}</div></div>`).join("")}</div>`;

  if (!e.xic) {
    body += e.reason !== "no-archive-for-run"
      ? `<div class="banner" style="margin-top:14px"><div>
          <b>Could not read the raw data for this row.</b> ${esc(e.detail ?? "")}
          The table and every other row are unaffected.
         </div></div>`
      : `<div class="banner" style="margin-top:14px"><div>
      <b>No raw data found for this run.</b>
      Runs pair with archives by the identity both sides already carry — the
      report's <span class="mono">Run</span>, here
      <span class="mono">${esc(k.run)}</span>, against the archive's
      <span class="mono">run.id</span>. Drop its
      <span class="mono">.mzpeak</span> beside the report and reopen. The
      filename is irrelevant: identity is read from inside the archive, so
      renaming or reorganising raw data cannot break the link.
      </div></div>`;
    $("evsrc").textContent = e.reason === "no-archive-for-run" ? "table only" : "read failed";
  } else {
    const x = e.xic;
    const sig = x.traces.some((t) => t.some((v) => v > 0));
    body += `
      <div class="layer">
        <div class="layer-head"><h3>Fragment ion chromatograms</h3>
          <span class="hint">${x.frames} frames · ${x.rowGroups} row groups</span></div>
        ${chart(x)}
        <div class="legend">${x.fragments.map((f, i) =>
          `<span><i style="background:${ionColour(i, x.series)}"></i>${esc(x.labels?.[i] ?? "?")} ${f.toFixed(2)}</span>`).join("")}</div>
        <p class="note-inline">
          Extracted from raw data in <b>${x.ms.toFixed(0)} ms</b> —
          ${(x.rowsDecoded / 1e6).toFixed(2)} M rows decoded,
          ${(x.rowsScanned / 1e3).toFixed(0)}k touched.
          ${x.measured
            ? "Fragments are the ions the engine itself scored, with its own m/z"
            : '<span class="err">Fragments are theoretical y-ions from the sequence</span>' +
              " — this report was written without <span class=\"mono\">--export-quant</span>"},
          read from <span class="mono">${esc(x.archive)}</span>.
          ${sig ? "" : '<span class="err">No signal in this window.</span>'}
        </p>
      </div>`;
    $("evsrc").textContent = `from raw · ${x.ms.toFixed(0)} ms`;
  }

  // Question 2, in the form it actually takes: identified in some runs, absent
  // in others. Rendered after the chart so the panel still leads with evidence.
  body += `<div class="layer" id="presenceLayer">
    <div class="layer-head"><h3>Across runs</h3>
      <span class="hint">click a missing run to interrogate it</span></div>
    <div id="presence" class="presence"><span class="muted">…</span></div>
  </div>`;

  const rows = Object.entries(e.extras).filter(([, v]) => Number.isFinite(v));
  if (rows.length) {
    body += `<div class="layer"><div class="layer-head"><h3>Reported by the engine</h3></div>
      <div class="ev-meta" style="margin:0">${rows.map(([a, v]) =>
        `<div><div class="k">${esc(a)}</div><div class="v mono">${
          Math.abs(v) >= 1e4 ? v.toExponential(1) : v.toFixed(3)}</div></div>`).join("")}</div></div>`;
  }
  ev.innerHTML = body;
  void paintPresence(state.sel);
}

/** The per-run found/missing strip. */
async function paintPresence(k) {
  const p = await window.api.presence(k);
  const el = $("presence");
  if (!p || !el) return;
  const head = $("presenceLayer")?.querySelector(".hint");
  if (head) {
    head.textContent = p.foundIn === p.of
      ? `identified in all ${p.of} runs`
      : `identified in ${p.foundIn} of ${p.of} — click a missing run`;
  }
  el.innerHTML = p.runs.map((r) => {
    const missing = !r.hit;
    const cls = missing ? (r.archive ? "miss" : "miss noraw") : "hit";
    const label = shortRun(r.name).slice(0, 16);
    const detail = r.hit
      ? `q ${fmtQ(r.hit.q)} · RT ${r.hit.rt.toFixed(2)}`
      : r.archive ? "not identified" : "no raw data";
    return `<button class="prun ${cls}" data-run="${r.index}"
        ${missing && r.archive ? "" : "disabled"} title="${esc(r.name)}\n${detail}">
        <span class="pname mono">${esc(label)}</span>
        <span class="pdetail">${detail}</span></button>`;
  }).join("");

  el.querySelectorAll("button.prun:not([disabled])").forEach((b) =>
    b.addEventListener("click", () => void interrogate(k, Number(b.dataset.run))));
}

/** Extracts evidence in a run where the engine found nothing. */
async function interrogate(k, runIndex) {
  const el = $("presence");
  el.insertAdjacentHTML("afterend",
    `<p class="note-inline" id="interrogating">Extracting from raw data…</p>`);
  const r = await window.api.interrogate(k, runIndex);
  $("interrogating")?.remove();
  if (!r) return;

  const box = document.createElement("div");
  box.className = "layer";
  if (!r.xic) {
    box.innerHTML = `<div class="banner"><div><b>Could not interrogate
      ${esc(shortRun(r.run))}.</b> ${esc(r.detail ?? r.reason ?? "")}</div></div>`;
  } else {
    const x = r.xic;
    const v = x.verdict;
    // Say what the fragments support, not what we hope they mean. One strong
    // trace in a wide isolation window is interference, not a peptide.
    const call = v.coeluting >= 3
      ? `<b>${v.coeluting} of ${v.total} fragments co-elute</b> at that coordinate —
         consistent with the peptide being present but unreported.`
      : v.present === 0
        ? `<span class="err">No fragment shows signal there — absent, not merely
           unscored.</span>`
        : `<b>${v.present} of ${v.total} fragments show signal</b>, but
           ${v.coeluting < 2 ? "they do not co-elute" : "only " + v.coeluting + " co-elute"} —
           more consistent with interference in the isolation window than with
           the peptide.`;
    box.innerHTML = `
      <div class="layer-head"><h3>Interrogated — ${esc(shortRun(r.run))}</h3>
        <span class="hint">${x.frames} frames · ${x.rowGroups} row groups</span></div>
      ${chart(x)}
      <div class="legend">${x.fragments.map((f, i) =>
        `<span><i style="background:${ionColour(i, x.series)}"></i>${esc(x.labels?.[i] ?? "?")} ${f.toFixed(2)}</span>`).join("")}</div>
      <p class="note-inline">
        <b>${esc(r.sequence)} ${r.charge}+</b> was not identified in this run.
        Evidence above was computed from the sequence and read from raw data in
        <b>${x.ms.toFixed(0)} ms</b> — no engine wrote a chromatogram for it.
        Retention time <b>${r.borrowedRt.toFixed(2)} min</b> ±${r.margin.toFixed(2)}
        ${x.measured ? "and the fragment list are" : "is"} borrowed from the
        ${r.donors} run${r.donors === 1 ? "" : "s"} that did find it, so
        ${x.measured ? "they are assumptions" : "it is an assumption"}, not
        measurements here.
        ${call}
      </p>`;
  }
  $("presenceLayer").after(box);
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * Colour by ion series, not by position.
 *
 * `docs/UI-DESIGN.md` assigns b-ions the OpenMS blue and y-ions its magenta, so
 * a trace's colour tells you which series it is. That only works once the real
 * series is known — with theoretical y-ions everything was one colour and the
 * distinction was decorative.
 */
const ionColour = (i, series) => {
  const s = series?.[i];
  if (s === "b" || s === "a" || s === "c") return "var(--ion-b)";
  if (s === "y" || s === "z" || s === "x") return "var(--ion-y)";
  return i % 2 ? "var(--ion-b)" : "var(--ion-y)";
};

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
    return `<path d="${d}" fill="none" stroke="${ionColour(i, x.series)}" stroke-width="1.35"
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

/** Sorting and per-column filtering live in the header itself. */
function wireHeader() {
  $("thead").querySelectorAll("th.sortable").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort = state.sort?.key === key
        ? (state.sort.dir === "asc" ? { key, dir: "desc" } : null)  // third click clears
        : { key, dir: "asc" };
      state.sel = 0;
      refresh();
    }));

  let t;
  $("thead").querySelectorAll("input[data-filter]").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());   // do not sort
    el.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.colFilters[el.dataset.filter] = el.value;
        state.sel = 0;
        refresh().then(() => {
          // Re-focus the box the user is typing in; refresh rebuilds the header.
          const again = $("thead").querySelector(`input[data-filter="${el.dataset.filter}"]`);
          if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
        });
      }, 220);
    });
  });
}

document.querySelectorAll(".grain button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.disabled || b.dataset.grain === state.grain) return;
    document.querySelectorAll(".grain button")
      .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    state.grain = b.dataset.grain;
    // Column keys differ per grain, so a carried-over sort or filter would
    // silently refer to a column that is no longer there.
    state.sort = null;
    state.colFilters = {};
    state.sel = 0;
    refresh();
  }));

$("openBtn").addEventListener("click", async () => {
  const p = await window.api.pick();
  if (!p) return;
  // Main pairs the report with a sibling .mzpeak on its own.
  await openSession(p);
});

$("fdr").addEventListener("input", (e) => {
  state.fdr = FDR_STOPS[Math.round((e.target.value / 100) * (FDR_STOPS.length - 1))];
  $("fdrOut").textContent = state.fdr.toFixed(3);

// A path on the command line opens straight into a session.
window.api.onAutoload?.((report) => {
  openSession(report).catch((e) => {
    $("sessionCtx").textContent = "could not open: " + (e?.message ?? e);
  });
});
window.api.onAutoloadFailed?.((input) => {
  $("sessionName").textContent = "Nothing to open";
  $("sessionCtx").textContent = `no report.parquet at ${input}`;
});
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

$("tbody").addEventListener("click", async (e) => {
  const tw = e.target.closest("[data-toggle]");
  if (tw) {
    const r = await window.api.toggle(tw.dataset.toggle);
    state.total = r.total;
    const p = await window.api.page(state.first, WINDOW);
    state.rows = p.rows;
    paint();
    return;
  }
  const tr = e.target.closest("tr");
  if (!tr) return;
  select(Number(tr.dataset.k));
});

async function select(k) {
  if (k < 0 || k >= state.total) return;
  state.sel = k;

  // Load the window first, *then* move the scrollbar. Repainting replaces the
  // tbody, and the browser resets scrollTop when it does — so setting the
  // position first leaves the viewport parked on a spacer, showing nothing.
  if (k < state.first || k >= state.first + state.rows.length) {
    await ensureWindow(k - Math.floor(WINDOW / 3));
  }

  const sc = $("scroller");
  const top = k * ROW_H;
  const viewTop = sc.scrollTop;
  const viewBottom = viewTop + sc.clientHeight - ROW_H;
  if (top < viewTop || top > viewBottom) {
    sc.scrollTop = Math.max(0, top - Math.floor(sc.clientHeight / 2));
  }
  for (const tr of $("tbody").children) {
    const on = Number(tr.dataset.k) === k;
    tr.classList.toggle("sel", on);
    tr.setAttribute("aria-selected", String(on));
  }
  $("count").textContent =
    `row ${(k + 1).toLocaleString()} of ${state.total.toLocaleString()}`;
  scheduleEvidence();
}

/**
 * Defers extraction while the cursor is still moving.
 *
 * Extraction reads raw data and takes the better part of a second on a dense
 * run, so holding an arrow key queues work far faster than it completes. The
 * in-flight token already stops a stale response overwriting a newer one, but
 * without this the panel still trails the cursor by every row passed through.
 * The first move is immediate; only a fast run of them waits.
 */
let evTimer = null;
let evIdle = true;
function scheduleEvidence() {
  clearTimeout(evTimer);
  if (evIdle) {
    evIdle = false;
    void showEvidence().finally(() => { evIdle = true; });
    return;
  }
  evTimer = setTimeout(() => {
    evIdle = false;
    void showEvidence().finally(() => { evIdle = true; });
  }, 130);
}

// Scroll drives which window is loaded. rAF-coalesced: a flung scrollbar fires
// far more events than there are frames, and each one would be an IPC round trip.
let scrollQueued = false;
$("scroller").addEventListener("scroll", () => {
  if (scrollQueued || !state.open) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const firstVisible = Math.floor($("scroller").scrollTop / ROW_H);
    if (firstVisible < state.first + OVERSCAN ||
        firstVisible + OVERSCAN > state.first + state.rows.length) {
      ensureWindow(firstVisible - OVERSCAN);
    }
  });
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); $("q").focus(); return; }
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowDown") { e.preventDefault(); select(state.sel + 1); }
  if (e.key === "ArrowUp") { e.preventDefault(); select(state.sel - 1); }
});

$("fdrOut").textContent = state.fdr.toFixed(3);

// A path on the command line opens straight into a session.
window.api.onAutoload?.((report) => {
  openSession(report).catch((e) => {
    $("sessionCtx").textContent = "could not open: " + (e?.message ?? e);
  });
});
window.api.onAutoloadFailed?.((input) => {
  $("sessionName").textContent = "Nothing to open";
  $("sessionCtx").textContent = `no report.parquet at ${input}`;
});
