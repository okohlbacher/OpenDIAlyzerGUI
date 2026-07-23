"use strict";
/**
 * Screen 0 — the experiment.
 *
 * The SDRF is the table, edited in place. Dropping files creates rows with
 * everything but the names blank, and Analyse is reachable immediately:
 * annotation is additive, never a gate. If Project blocked "I have six files,
 * search them", people would skip it and the design data would never be
 * entered at all.
 */
let proj = null;

async function paintProject(state) {
  proj = state ?? (await window.api.project.get());

  for (const el of document.querySelectorAll(".inv")) {
    if (document.activeElement !== el) el.value = proj.investigation[el.dataset.inv] ?? "";
  }

  $("pthead").innerHTML = `<tr>${proj.columns.map((c) =>
    `<th title="${esc(c)}">${esc(c.replace(/^(characteristics|comment|factor value)\[/, "").replace(/\]$/, ""))}</th>`
  ).join("")}</tr>`;

  const missing = new Set(proj.issues.filter((i) => i.blocking).map((i) => i.row + "|" + i.column));
  $("ptbody").innerHTML = proj.rows.map((r, i) =>
    `<tr>${proj.columns.map((c) =>
      `<td class="${missing.has(i + "|" + c) ? "missing" : ""}"><input data-row="${i}"
         data-col="${esc(c)}" value="${esc(r.values[c] ?? "")}"
         aria-label="${esc(c)} row ${i + 1}"></td>`).join("")}</tr>`).join("");

  $("ptbody").querySelectorAll("input").forEach((el) =>
    el.addEventListener("change", async () => {
      paintProject(await window.api.project.setValue(
        Number(el.dataset.row), el.dataset.col, el.value));
    }));

  // Suggested columns are offered, never imposed.
  $("pcols").innerHTML = `<button class="linkish" id="paddFactor">+ factor value…</button>` +
    proj.suggested.slice(0, 4).map((c) =>
      `<button class="linkish addcol" data-col="${esc(c)}" style="margin-left:8px">+ ${
        esc(c.replace(/^characteristics\[|^comment\[/, "").replace(/\]$/, ""))}</button>`).join("");
  $("pcols").querySelectorAll(".addcol").forEach((b) =>
    b.addEventListener("click", async () =>
      paintProject(await window.api.project.addColumn(b.dataset.col))));
  $("paddFactor")?.addEventListener("click", async () => {
    const name = prompt("Factor name — what is being compared?", "group");
    if (name) paintProject(await window.api.project.addColumn(`factor value[${name.trim()}]`));
  });

  const blocking = proj.issues.filter((i) => i.blocking);
  const notes = proj.issues.filter((i) => !i.blocking);
  $("pissues").innerHTML = proj.rows.length === 0 ? "" :
    (blocking.length
      ? `<div class="issue"><span class="mark">⚠</span><span>${blocking.length} required
          value${blocking.length === 1 ? "" : "s"} still empty — needed for a valid submission,
          not for analysis. You can search now and finish this later.</span></div>` : "") +
    notes.map((n) => `<div class="issue note"><span class="mark">·</span><span>${
      n.row >= 0 ? `row ${n.row + 1}: ` : ""}${esc(n.message)}</span></div>`).join("");

  $("pcount").textContent = proj.rows.length
    ? `${proj.rows.length} run${proj.rows.length === 1 ? "" : "s"} · ${proj.columns.length} columns`
    : "no files yet";
  $("toAnalyse").disabled = proj.rows.length === 0;
}

// ── screens ──────────────────────────────────────────────────────────────────

/**
 * Three places, not three steps. Every arrow goes both ways, and a project
 * opens where the work is rather than at the beginning.
 */
function showScreen(name) {
  $("project").hidden = name !== "project";
  $("setup").hidden = name !== "analyse";
  document.querySelector(".panes").style.display = name === "results" ? "" : "none";
  document.querySelectorAll(".nav button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.screen === name)));
  if (name === "project") paintProject();
}

document.querySelectorAll(".nav button").forEach((b) =>
  b.addEventListener("click", () => showScreen(b.dataset.screen)));

$("toAnalyse").addEventListener("click", async () => {
  // The runs are already known — carry them across rather than asking again.
  if (proj?.rows.length) await addRuns(proj.rows.map((r) => r.path).filter(Boolean));
  showScreen("analyse");
});

$("paddFiles").addEventListener("click", async () => {
  const paths = await window.api.pickRuns();
  if (paths.length) paintProject(await window.api.project.addFiles(paths));
});
$("pclear").addEventListener("click", async () => {
  if (!proj?.rows.length ||
      confirm(`Discard ${proj.rows.length} annotated run(s)? Export first if you need them.`)) {
    paintProject(await window.api.project.clear());
  }
});
$("pimport").addEventListener("click", async () =>
  paintProject(await window.api.project.import()));
$("pexport").addEventListener("click", async () => {
  const p = await window.api.project.export();
  if (p) $("pcount").textContent = "exported to " + p;
});

const pdrop = $("pdrop");
for (const ev of ["dragenter", "dragover"]) {
  pdrop.addEventListener(ev, (e) => { e.preventDefault(); pdrop.classList.add("over"); });
}
for (const ev of ["dragleave", "drop"]) {
  pdrop.addEventListener(ev, (e) => { e.preventDefault(); pdrop.classList.remove("over"); });
}
pdrop.addEventListener("drop", async (e) => {
  const paths = [...e.dataTransfer.files]
    .map((f) => { try { return window.api.pathOf(f); } catch { return null; } })
    .filter(Boolean);
  if (paths.length) paintProject(await window.api.project.addFiles(paths));
});
