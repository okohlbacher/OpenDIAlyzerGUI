"use strict";
/**
 * Screen 1 — the four questions, then the plan.
 *
 * `docs/WORKFLOW.md` asks four things: which runs, which sequences, what kind of
 * peptides, where output goes. Everything else is measured from the data or
 * fixed by policy, so it is not asked.
 *
 * The plan is previewable with no engine installed. That is not a nicety: DIA-NN
 * ships no macOS build, so on a Mac this screen can only ever assemble a plan to
 * run elsewhere — and being able to see the exact config it would write is the
 * whole value in that case.
 */
const setup = {
  runs: [],
  formats: [],
  requirements: [],
  fasta: null,
  library: null,
  outputDir: null,
  preset: "tryptic",
  engines: [],
  engine: null,
  platformSupported: true,
  cores: 8,
};

function showSetup(show) {
  $("setup").hidden = !show;
  document.querySelector(".panes").style.display = show ? "none" : "";
  $("backToResults").hidden = !state.open;
}

async function initSetup() {
  const info = await window.api.engines();
  setup.engines = info.installs;
  setup.engine = info.installs[0] ?? null;
  setup.platformSupported = info.platformSupported;
  setup.cores = info.cores;
  paintEngine(info);

  const presets = await window.api.presets();
  $("presets").innerHTML = presets.map((p) =>
    `<button class="preset" data-preset="${p.id}" aria-pressed="${p.id === setup.preset}">
       ${esc(p.label)}<small>${esc(p.note)}</small></button>`).join("");
  $("presets").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      setup.preset = b.dataset.preset;
      $("presets").querySelectorAll("button")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      refreshSetupState();
    }));
}

function paintEngine(info) {
  const el = $("engineVal");
  if (setup.engines.length) {
    el.innerHTML = setup.engines.map((i, n) =>
      `<div class="req ok"><span class="mark">✓</span>
         <span><span class="mono">DIA-NN ${esc(i.version)}</span>
         ${i.edition ? esc(i.edition) : ""} · ${esc(i.path)}</span></div>`).join("") +
      `<div class="req"><span class="mark"> </span><span class="muted">
         ${info.cores} cores, ${info.totalMemGb} GB on this machine</span></div>`;
    return;
  }
  // Distinguish "not installed here" from "cannot exist here". A Mac user
  // hunting for a download that does not exist is a wasted afternoon.
  el.innerHTML = info.platformSupported
    ? `<div class="req no"><span class="mark">✗</span><span>No DIA-NN found.
         Install it and reopen, or preview the plan below and run it elsewhere.</span></div>`
    : `<div class="req no"><span class="mark">✗</span><span><b>DIA-NN has no macOS
         build.</b> The plan below is still exact — run it on Linux or Windows, or
         on a cluster. Reading results here needs no engine at all.</span></div>`;
}

async function addRuns(paths) {
  if (!paths.length) return;
  const seen = new Set(setup.runs.map((r) => r.path));
  const info = await window.api.inspect(paths, setup.engine?.path);
  for (const r of info.runs) if (!seen.has(r.path)) setup.runs.push(r);
  setup.formats = info.formats;
  setup.requirements = info.requirements;

  const gb = setup.runs.reduce((n, r) => n + r.bytes, 0) / 2 ** 30;
  const byFormat = {};
  for (const r of setup.runs) byFormat[r.format] = (byFormat[r.format] ?? 0) + 1;
  $("acq").innerHTML =
    `${setup.runs.length} run${setup.runs.length === 1 ? "" : "s"} · ` +
    Object.entries(byFormat).map(([f, n]) => `${n}× ${f}`).join(" · ") +
    ` · ${gb.toFixed(1)} GB` +
    (setup.requirements.length
      ? "<br>" + setup.requirements.map((q) =>
          `<span class="req ${q.ok ? "ok" : "no"}"><span class="mark">${q.ok ? "✓" : "✗"}</span>
            <span>${esc(q.name)} — ${esc(q.detail)}${q.ok ? "" :
              ` <b>needed for ${esc(q.needed)}</b>`}${q.remedy ? ` · ${esc(q.remedy)}` : ""}</span></span>`
        ).join("")
      : "");
  refreshSetupState();
}

function refreshSetupState() {
  const ready = setup.runs.length > 0 && (setup.fasta || setup.library) && setup.outputDir;
  $("previewPlan").disabled = !ready;
  // Running needs an engine as well as a plan; previewing does not.
  $("runPlan").disabled = !ready || !setup.engine;
  $("runPlan").title = setup.engine ? "" : "no engine installed — preview the plan instead";
}

async function previewPlan() {
  const r = await window.api.buildPlan({
    runs: setup.runs.map((x) => x.path),
    fasta: setup.fasta ?? undefined,
    library: setup.library ?? undefined,
    outputDir: setup.outputDir,
    preset: setup.preset,
    threads: Math.max(4, Math.min(setup.cores, 96)),
  });

  const tight = r.estimatedMemGb > r.hostMemGb * 0.8;
  $("planOut").innerHTML = `
    <p class="note-inline" style="margin-top:18px">
      ${r.stages.length} stages · calibrate once, then one per run, then combine.
      Per-run stages are independent, so a bad file loses that file rather than
      the batch, and the combine step can be restarted on its own.
      ${r.sequences ? `${r.sequences.toLocaleString()} FASTA entries · ` : ""}
      estimated peak memory <b class="${tight ? "err" : ""}">${r.estimatedMemGb.toFixed(0)} GB</b>
      against ${r.hostMemGb} GB here${tight ? " — this will not fit" : ""}.
    </p>` +
    r.stages.map((s) => `
      <details class="stage">
        <summary><span class="mono">${esc(s.id)}</span> · ${esc(s.label)}</summary>
        <pre>${esc(s.cfg)}</pre>
      </details>`).join("");
}

// ── wiring ───────────────────────────────────────────────────────────────────

$("pickRuns").addEventListener("click", async () => addRuns(await window.api.pickRuns()));
$("pickFasta").addEventListener("click", async () => {
  const p = await window.api.pickFile("fasta");
  if (p) { setup.fasta = p; setup.library = null; }
  $("seqVal").textContent = setup.fasta ?? setup.library ?? "none chosen";
  refreshSetupState();
});
$("pickLib").addEventListener("click", async () => {
  const p = await window.api.pickFile("lib");
  if (p) { setup.library = p; setup.fasta = null; }
  $("seqVal").textContent = setup.library ?? setup.fasta ?? "none chosen";
  refreshSetupState();
});
$("pickOut").addEventListener("click", async () => {
  const p = await window.api.pickFile("out");
  if (p) setup.outputDir = p;
  $("outVal").textContent = setup.outputDir ?? "none chosen";
  refreshSetupState();
});
$("previewPlan").addEventListener("click", previewPlan);
$("newBtn").addEventListener("click", () => showSetup(true));
$("backToResults").addEventListener("click", () => showSetup(false));

const drop = $("drop");
for (const ev of ["dragenter", "dragover"]) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
}
for (const ev of ["dragleave", "drop"]) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
}
drop.addEventListener("drop", (e) => {
  const paths = [...e.dataTransfer.files]
    .map((f) => { try { return window.api.pathOf(f); } catch { return null; } })
    .filter(Boolean);
  addRuns(paths);
});

initSetup();
