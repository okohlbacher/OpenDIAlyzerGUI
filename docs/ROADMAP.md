# Delivery phases

Each phase ships something useful on its own — the same discipline the engine
project adopted as D10 (`vault/70-Adversarial/Adversarial review log.md`). No
phase is a prerequisite refactor for the next.

The ordering is not arbitrary. **Phase 1 makes one architectural choice — a
range-read abstraction over the raw data — and that single choice is what makes
phase 5 cheap.** Everything else is additive.

| | Phase | Ships | Depends on |
|---|---|---|---|
| **1** | The workbench | Cross-platform tool that **sets up, runs and inspects DIA-NN**, with on-demand drilldown. Ships value with no OpenDIAlyzer engine present | — |
| **2** | Provenance | Hash-linked audit log; methods text and machine-readable record generated, never typed | 1 |
| **3** | SDRF / ISA, metadata, annotation | Experiment design as an editable grain; curation state as data | 1 |
| **4** | Repository submission | One validated ProteomeXchange / PRIDE package | 2, 3 |
| **5** | Cluster and cloud | Remote CUDA engine; object-store datasets | 1 (only) |

---

## Phase 1 — The workbench

Specified in `docs/UI-DESIGN.md`, `docs/WORKFLOW.md`, `docs/DIANN-COMPAT.md`.

**Phase 1 is engine-complete against DIA-NN**, because the OpenDIAlyzer engine
is not ready and the GUI must not be blocked on it. That means detection and
runtime verification, the four-question → flag mapping, the
calibrate → per-run → aggregate run plan, legible failures, and reading the
results. `odia` slots in behind the same `Engine` interface later without
changing a screen.

The one decision that constrains everything later:

> **All raw-data access goes through a `RangeReader` interface — `read(offset,
> length) → bytes` — with a local-file implementation today and an HTTP-range
> implementation later. No component above it ever sees a file path.**

mzPeak is a STORED (uncompressed) ZIP of Parquet facets, so member offsets are
directly addressable and Parquet row-group statistics permit seeking to an RT
region (m/z is unindexed — see `docs/ARCHITECTURE.md`). That property is what makes the drilldown fast locally, and it
is *the same property* that makes it work against S3 over HTTPS. Getting this
interface right in phase 1 costs perhaps a day. Retrofitting it in phase 5
costs a rewrite of every panel.

`// ponytail: one interface, two implementations, and the second one is not
// written yet. This is the only speculative abstraction in the design, and it
// is justified because the alternative is rewriting the data path.`

---

## Phase 2 — Provenance

The user requirement is "full documentation of all processing steps". The
reference implementation already exists and is worth copying closely.

### Steal Skyline's audit log, and its exact properties

Skyline ships `.skyl`, described in
[PMC7520049](https://pmc.ncbi.nlm.nih.gov/articles/PMC7520049/):

- tracks **all document modifications made through the GUI *or* the command line**
- stored as **language-independent, human-readable XML**
- **linked to the document through a hash of the document**
- displayed in an interactive grid, with **undo-to-here**

Their stated motivation is the exact problem: *"it was nearly impossible to know
how a Skyline document and its data were processed without detailed notes kept
during creation and processing."*

**Spectronaut has no equivalent.** Its 210-page manual documents an
`Export Experiment Settings` action — a settings snapshot, not a provenance
chain. That absence is the clearest single differentiator available.

### What we record

Not just parameters — the graph.

| Recorded | Why |
|---|---|
| Every processing step: stage, software version + build, parameters, wall time | The methods paragraph |
| **Provenance of each parameter**: preset / measured / user override | DIA-NN's log tells you the value, never where it came from |
| Content hashes of every input and output | Filename-keyed provenance is what makes DIA-NN's `.quant` reuse fragile |
| Every manual curation: peak boundary moved, match accepted/rejected, fragment excluded | Spectronaut marks touched nodes with a hand icon — good; make them *queryable* |
| The instruction set / host / thread counts | DIA-NN documents that CPU instruction set changes prediction output |

### The upgrade that matters: make it replayable

Skyline's own paper is explicit that its log *"was not designed to allow for
automatic reproduction of a document state"* — it exists to help you navigate
the GUI by following entries. It is a diary, not a script.

> **We log a canonical, re-executable operation stream.** "Reproduce this
> analysis" is a command, not a reading exercise.

That single difference is the biggest available upgrade over the best
provenance implementation in the field, and it is only cheap if the operation
stream *is* the way the application mutates state — which is a phase-1
architectural decision, not a phase-2 feature.

### Failure modes to design out, taken from the incumbents

- **The log must survive the crash.** In Skyline and DIA-NN alike, a hard crash
  can destroy the only diagnostic artefact ([DIA-NN D#626](https://github.com/vdemichev/DiaNN/discussions/626)).
  Append-and-fsync per step, never buffer to the end.
- **The manifest must not lie.** DIA-NN
  [#1457](https://github.com/vdemichev/DiaNN/issues/1457) records a manifest
  claiming QuantUMS was active while legacy quantification actually ran. The
  record is generated *from* the executed graph, never written alongside it.
- **Version the semantics, not just the software.** Spectronaut 19 silently
  changed the differential-abundance default from MS1+MS2 to MS2-only, so
  re-running an old experiment at "factory settings" produces different numbers.
  Pin the semantic version in the result file and refuse to silently
  re-interpret an old result under new defaults.
- **On by default.** Skyline's is opt-in, and the commonest user question about
  the resulting file is *"can I delete it?"* An opt-in integrity feature has
  already failed.
- **A hash mismatch is an error, not a dismissible toast.** Skyline's support
  team routinely tells users *"you can safely ignore that warning"*, which kills
  the guarantee socially regardless of the cryptography.
- **SHA-256, Merkle-chained, optionally signed** — Skyline uses SHA-1 and its
  paper concedes the scheme *"would not prevent a determined adversary"*. And we
  **never claim 21 CFR Part 11 compliance**, which neither tool has.
- **Log outcomes, not intentions.** Skyline records failed operations without
  rolling them back, so its log can assert something that never happened.
- **Coalesce bulk operations** into one entry with a count; a per-property diff
  logger floods on bulk refinement.
- **One code path for GUI and CLI.** Skyline shipped audit logging in 2018 and
  was still closing command-line coverage gaps in 2024 — six years of silent
  provenance holes in exactly the headless runs that most need them.
- **Redaction before sharing.** Skyline entries can embed pasted clipboard
  content, which is useful for support and a confidentiality problem in pharma.

The full ten failure modes, with sources, are in `docs/COMPETITIVE.md` §C5.

### Ships

A Provenance panel (already sketched in `docs/mockup.html`), a copy-to-clipboard
methods paragraph, and an exported record. Format decision deferred to
implementation — RO-Crate and CWL are both plausible; the requirement is
machine-readable and hash-linked, not a particular schema.

---

## Phase 3 — SDRF / ISA, metadata, annotation

### SDRF is a grain, not an import dialog

The workbench already has a grain selector (Precursors / Proteins / Runs). SDRF
describes *runs*. So:

> **SDRF becomes the Runs grain's column set — characteristics, factor values
> and comments, edited in place.**

No new screen, no second editor, no import-then-diverge. And because design
metadata lives in the same table model as everything else, a factor value is
immediately usable as a filter, a colour-by and a submission field.

Round-trips `.sdrf.tsv` losslessly, validates against the PSI SDRF-Proteomics
specification, and reports validation failures as rows in the same table rather
than as a modal.

ISA (Investigation → Study → Assay) sits one level above and is a small
project-level panel: a study can contain several assays, each mapping to a set
of runs.

### Annotation and curation state

The `Space`-to-flag affordance in phase 1 grows into a real curation layer:
per-entity flags, free-text notes, and a review status. Two rules:

1. **Curation is data, not UI state.** It goes in the result store, exports with
   everything else, and appears in the audit log.
2. **Evidence class is visible.** Every identification renders how it was
   obtained — directly observed in this run, transferred between runs, or
   imputed — as a glyph *and* a filterable column.

Rule 2 is not a nicety. A two-species spike-in control found that Spectronaut's
library-free defaults reported **1,514 peptides and 938 proteins — about 16 % of
the *C. albicans* proteome — in samples that contained no *C. albicans***, driven
by cross-run identification transfer, with nothing in the UI distinguishing a
transferred ID from an observed one
([J. Proteome Res. 10.1021/acs.jproteome.3c00671](https://pubs.acs.org/doi/10.1021/acs.jproteome.3c00671)).
Making evidence class visible is a correctness feature wearing a UI costume.

---

## Phase 4 — Repository submission

One action assembles a complete, validated ProteomeXchange / PRIDE **bundle**:
raw files, results, the SDRF, the ISA metadata and the provenance graph.

**What "one action" does and does not include (plan review).** Assembling and
validating the bundle is the tractable part and is what phases 2–3 make small.
The parts it cannot make one-click: ProteomeXchange requires an Aspera/`px-submit`
upload of tens of GB (a supervised transfer, not a button), a PX submission.px
XML with **submitter and lab-head as distinct contacts**, a dataset licence, and
keywords — none of which SDRF carries, and `src/sdrf.ts` currently models a
single contact. So Phase 4's deliverable is a *validated submission bundle plus a
supervised upload*, and Phase 3 must add CV-term binding for instrument,
modifications and cleavage agent, and split contact into submitter/PI. This phase
is small *because* phases 2 and 3 did the work, not because submission is
trivial. A submission is
mostly a rearrangement of metadata that is already tracked and already
validated. If submission feels large when we get here, it means phase 2 or 3
under-delivered, and that is the signal to fix them rather than to write a
submission wizard that collects the same facts a second time.

Validation runs continuously from phase 3 onward, not at submission time — the
Runs grain shows which required fields are missing long before anyone clicks
Submit. Nobody should discover on submission day that the organism part was
never recorded.

---

## Phase 5 — Cluster and cloud

Two separable pieces.

### Remote compute

The engine moves to a cluster with CUDA available; the GUI stays a client. Note
the engine project's own position: GPU work is gated behind measurement, not
assumed — the adversarial review concluded the gather is latency-bound and
GPU-hostile, and that scoring only becomes GPU-worthy after the direct-addressed
bin redesign (`vault/70-Adversarial/Adversarial review log.md`, F2/F4). So this
phase provides the *plumbing* for remote execution; whether the remote executor
uses GPUs is the engine's decision, measured separately.

What the GUI must provide:

- **Submit, monitor, and reattach.** Closing the laptop must not kill the job,
  and reopening must reattach to a running one.
- **Phase-2-only restart on a bigger machine.** The most expensive failure in
  the DIA-NN corpus is [15 hours of per-run work destroyed by one word,
  `Killed`, at the cross-run assembly step](https://github.com/vdemichev/DiaNN/discussions/1710)
  — with every per-run intermediate intact on disk. Content-addressed
  intermediates plus a restartable aggregation stage turn that from a lost day
  into a re-queue on a larger node.
- **Pre-flight resource estimation.** Spectronaut publishes
  `RAM_GB = 5.0 + 0.6·n·r / 1024²` (n = library precursors, r = runs) on page 12
  of a PDF; DIA-NN documents ~0.5 GB per million library precursors in its
  README. Both belong in a live sidebar next to the Analyse button, showing
  predicted memory, disk and wall time *before* the job is committed — and a
  refusal, with an explanation, when the target node cannot hold it.

### Cloud data management

Datasets in object storage, read through the same `RangeReader` from phase 1.
An HTTP-range implementation over S3 is roughly a hundred lines; the panels
above it do not change at all, because they never knew what a file was.

Beyond that: projects and access control, shared sessions, and a read-only link
to a result that a reviewer or collaborator can open without installing
anything. That last one matters commercially — Spectronaut's viewer is free but
Windows-only, and Skyline requires a Windows install to open a `.sky.zip`. A URL
that opens the actual evidence, cross-platform, is a genuinely uncontested
position.

---

## What is deliberately not on this roadmap

| Not planned | Why |
|---|---|
| Differential abundance, PCA, pathway enrichment | DIA-NN 2.6 ships all of it, free. Export instead. |
| A GUI pipeline/batch-step builder | The CLI is the pipeline; a GUI builder is a worse shell script |
| Spectral library editing | Libraries are inputs. (Spectronaut's in-review library refinement is genuinely good — reconsider only if users ask.) |
| A plugin system | No second implementor exists |
| Redistributing or bundling DIA-NN | Not permitted by the vendor, and not wanted. We detect and invoke the user's own install — *running* DIA-NN is Phase 1 scope, see `docs/DIANN-COMPAT.md` |
