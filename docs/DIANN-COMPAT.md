# DIA-NN interoperation — read *and* run

The OpenDIAlyzer engine is early-stage and has an unsolved research problem at
its core (`vault/70-Adversarial/Adversarial review log.md`, F5/D6). The GUI
cannot wait for it. So:

> **The workbench is fully usable with DIA-NN as the only engine installed.**
> It finds DIA-NN, helps you set it up, runs it, and reads its results — and
> OpenDIAlyzer becomes a second engine behind the same four questions when it
> is ready.

That inverts the usual dependency. The GUI is not a front-end for our engine
that happens to import DIA-NN; it is a workbench that ships value on day one
against the tool people already use, and gains an engine later.

## On the licence question

We never redistribute DIA-NN. The user installs it under their own agreement
with the vendor; we locate and invoke a binary already on their machine. That is
the same thing DIA-NN's own GUI does, and its README explicitly supports it:

> "The command-line tool can also be used separately, e.g. as part of custom
> automated processing pipelines."

The unread-licence risk recorded in
`vault/10-DIA-NN/DIA-NN licence terms are unverified.md` is about **publishing
comparative benchmarks**, not about invocation. It still gates benchmark
publication; it does not gate this.

One consequence to be honest about: DIA-NN ships as **Academia** (free,
"limited functionality") and **Enterprise**, and the limits are not enumerated
anywhere public. The GUI therefore records **which edition and build** produced
every result, and shows it next to the numbers.

---

# Part 1 — Running DIA-NN

## Setup: detect, verify, guide

No silent downloads. Setup is three steps, all of which report clearly.

**1. Detect.** Scan `PATH`, the conventional install locations, and any
user-specified path. Multiple versions side by side are expected and supported —
DIA-NN's own FAQ recommends keeping old versions for reproducible reprocessing.

**2. Identify.** Invoke with no arguments and parse the banner, which yields
version, edition and the CPU instruction set:

```
DIA-NN 2.6.1 Academia  (Data-Independent Acquisition by Neural Networks)
Compiled on Jun 30 2026 14:41:29
Logical CPU cores: 224
```

The instruction set matters: DIA-NN documents that in-silico prediction *"will
yield slightly different results depending on the instruction set supported by
the CPU"*. It goes in the provenance record.

**3. Verify the runtime.** This is the single largest support category in the
DIA-NN tracker — **77 maintainer replies** are "install the right runtime". We
check before the run, not during it:

| Need | Checked by | When |
|---|---|---|
| .NET 8+ runtime | `dotnet --list-runtimes` | Thermo `.raw` on Linux, and 2.1.0+ generally |
| `libtimsdata` | present in the install dir | Bruker `.d` |
| Sciex Clearcore DLLs | present in the install dir | `.wiff`; **not available on native Linux** |
| Output directory writable | direct test | always |

Each failure produces the exact remedial command, at drop time. A missing .NET
runtime must never surface as a failure at hour three.

**If DIA-NN is absent**, we link to the official release page, accept a
drag-and-dropped archive, unpack it, and run the same verification. An assisted
one-click fetch from the vendor's own release URL is possible later, behind an
explicit licence acknowledgement — deferred, because "detect and guide" is a
tenth of the work and covers the common case.

## The four questions map onto DIA-NN's flags

`docs/WORKFLOW.md` asks four questions. Here is the whole translation for the
two presets that matter most. Nothing else is asked of the user.

| Our concept | DIA-NN flags |
|---|---|
| Runs | written into a `--cfg` file as `--f` lines (see below) |
| FASTA | `--fasta`, plus `--fasta-search` and `--predictor` for library-free |
| Spectral library | `--lib` |
| Output | `--out`, `--temp` |
| **Preset: Tryptic proteome** | `--cut K*,R*,!*P --missed-cleavages 1 --min-pep-len 7 --max-pep-len 30 --min-pr-charge 2 --max-pr-charge 4 --met-excision` |
| **Preset: Immunopeptidomics HLA-I** | `--cut ** --missed-cleavages 100 --min-pep-len 8 --max-pep-len 12 --min-pr-charge 1 --max-pr-charge 3` |
| **Preset: Immunopeptidomics HLA-II** | `--cut ** --missed-cleavages 100 --min-pep-len 13 --max-pep-len 25 --min-pr-charge 2 --max-pr-charge 4` |
| Precursor / fragment m/z range | **measured from the acquisition**, then `--min-pr-mz` / `--max-pr-mz` |
| Mass accuracy, scan window | **measured in a calibration pass**, then pinned — see below |
| Threads | `--threads`, chosen per stage |

`--cut **` with a high missed-cleavage count is DIA-NN's documented
non-specific digest. Its README warns to *"first do this for a single peptide
length, to estimate the numbers of precursors generated"* — so the HLA presets
run a candidate-count estimate first and show the number before committing.

**Charge 1 in the HLA-I preset is the point.** A large singly-charged population
is exactly what tryptic defaults exclude, and it is the commonest silent failure
when HLA data goes through a proteome workflow.

## Two policies we impose that DIA-NN does not

**Write everything, filter later.** We always pass `--qvalue 0.5`, so the report
contains everything down to 50 % precursor q-value and the FDR slider in the
workbench re-filters instantly. This is documented and supported — DIA-NN's own
README notes the matrices can be reproduced from a report generated at 50 % FDR.
It removes a whole class of "I have to re-run it" from the workflow.

We do **not** generate matrices (`--matrices`) — they are derivable from the
report, and two sources of truth is precisely what produced
[#1056](https://github.com/vdemichev/DiaNN/issues/1056).

**Always `--export-quant`.** It writes the engine's own fragments into the
report: `Fr.N.Id` is `y6^1/704.372620` — series, ordinal, charge and exact m/z —
alongside each fragment's measured quantity and score. That removes any need to
read a spectral library, and it is strictly better than computing theoretical
ions, which for a long peptide picks the wrong series entirely. On the AGXT
G170R variant (23-mer, 3+) DIA-NN scored `y6`, `y7`, `b14²⁺`, `y8`, `y6²⁺` and
`y19²⁺`; a naive y-series guess reached for `y17`–`y22` at 1800–2386 Th, above
the instrument's 1700 Th ceiling, and saw nothing at all.

`.speclib` stays unread — it is undocumented, and with `--export-quant` there is
nothing left in it that we need.

**Never `--xic`.** We do not ask DIA-NN for chromatograms at all. We read raw
data ourselves through mzPeak, which is faster to produce, costs no disk, and —
unlike `.xic.parquet` — can answer questions about precursors DIA-NN rejected.
Skipping it saves both time and the disk blow-up its own docs warn about.

## The run plan: calibrate → per-run → aggregate

This is the most valuable thing the GUI does with DIA-NN, and it uses only
documented flags.

```
  STAGE 0   library generation (once, cached by FASTA hash + digest params)
            --fasta-search --predictor --gen-spec-lib --out-lib …
                        │
  STAGE 1   CALIBRATE on one representative run, wide --mass-acc-cal
            → parse optimised MS1/MS2 accuracy and scan window from the log
                        │
  STAGE 2   PIN  --mass-acc N --mass-acc-ms1 M --window W
                        │
  STAGE 3   PER-RUN — one invocation per file → one .quant each
            ├── run 1  ──┐
            ├── run 2  ──┤  independent · resumable · schedulable
            └── run N  ──┘
                        │
  STAGE 4   AGGREGATE — all runs, --use-quant (+ --reanalyse for MBR)
            → report.parquet
```

DIA-NN's *Incremental processing* section describes exactly this pattern and
states its prerequisite — *"make sure that the mass accuracies and the scan
window are fixed to specific values"* — which stages 1–2 satisfy by
construction.

> **Not yet verified, and it is the highest-risk assumption in the whole plan.**
> The isolation, checkpoint and order-independence claims below rest on the
> per-run `.quant` files being *discovered and reused* by the aggregate stage
> exactly as a monolithic run would produce them. Three things are unproven:
>
> - **`.quant` discovery.** `--use-quant` finds files by raw-file name in the
>   temp/output dir. The stage-4 config lists `--f` for every run, so the raw
>   files must still be reachable at aggregation — the checkpoint is not "the
>   `.quant` files alone", contrary to an earlier phrasing here. If the raw
>   files moved, stage 4 needs dummy placeholders (DIA-NN #1909), which the plan
>   does not yet create.
> - **MBR.** `--reanalyse` re-searches in a second cross-run pass using an
>   empirical library; whether a per-run-then-aggregate split reproduces a
>   monolithic MBR result is untested and plausibly *not* equal.
> - **Library re-prediction.** If mass accuracies are not pinned, the aggregate
>   stage can re-optimise and diverge from the per-run stages — which is why the
>   pin (stage 2) is mandatory, not optional.
>
> **The settling experiment (spike 0, before any of Phase 1 ships):** on a
> platform where DIA-NN runs — not this Mac, which has no DIA-NN build — search
> two files monolithically, then via this split, and diff the reports. Until
> that passes, the run plan is a design, not a guarantee.

What that buys *if the split reproduces the monolith*, mapped to documented
DIA-NN failures:

| Property | Fixes |
|---|---|
| **Per-file isolation.** One unreadable file loses that file, not the batch | [#1787](https://github.com/vdemichev/DiaNN/issues/1787) — dies on file 101 of 500, user bisected by hand |
| **Real checkpointing.** Stage 4 restarts alone, on a bigger machine | [D#1710](https://github.com/vdemichev/DiaNN/discussions/1710) — 14.9 h destroyed by one word, `Killed`, with every `.quant` intact |
| **Order independence.** Accuracies pinned once, so results do not depend on run order | [#1766](https://github.com/vdemichev/DiaNN/issues/1766) renaming a file changes every ID; [#778](https://github.com/vdemichev/DiaNN/issues/778) *"Order of files matters"* broke quantms reproducibility |
| **Safe `.quant` reuse.** Reuse is only offered when accuracies are pinned and the DIA-NN build matches, both of which we record | [#1986](https://github.com/vdemichev/DiaNN/issues/1986), [D#494](https://github.com/vdemichev/DiaNN/discussions/494) — version-incompatible `.quant` |
| **Progress that means something.** N of M runs complete, each with a state | three literal strings and a coloured lamp |

Stage 3 is also where remote execution slots in unchanged (`docs/ROADMAP.md`
Phase 5): N independent invocations is an embarrassingly parallel queue.

MBR is the exception — `--reanalyse` is inherently cross-run and holds `.quant`
in memory during its second pass. It therefore lives entirely in stage 4, and
the pre-flight estimate accounts for it separately.

## Invocation hygiene

**Always via `--cfg`.** Every invocation writes a config file and passes only
`--cfg`. This sidesteps command-line length limits entirely rather than at 32,000
characters, avoids shell quoting differences across platforms, and — usefully —
*the config file is the provenance artefact*, byte-identical to what ran.

Pre-flight validation, each item earning its place from a real failure:

- **Reject paths containing `--`.** A directory named `search--export` produces a malformed command line, no output, and a "don't do that" resolution ([#1917](https://github.com/vdemichev/DiaNN/issues/1917)).
- **Verify the output directory is writable** before starting. DIA-NN defaults to its working directory, which is read-only for a `C:\Program Files` install — and the resulting error goes to a discarded stderr.
- **Estimate memory** from library size at DIA-NN's own documented rate, ~0.5 GB per million library precursors, and refuse with an explanation rather than dying at hour twelve.
- **Order inputs deterministically by content hash**, not by filename, so a rename cannot perturb anything.
- **Capture stderr.** DIA-NN's GUI sets `RedirectStandardOutput` but never `RedirectStandardError`, with no console to inherit, so everything DIA-NN writes there is invisible today.

## Making failures legible

DIA-NN's primary error surface is a raw Windows NTSTATUS code, and the most
repeated sentence in its entire issue tracker is a request for the log. We
translate:

| DIA-NN emits | We show |
|---|---|
| `Process exited with code 3221226505` (`0xC0000409`) | "DIA-NN crashed (stack corruption). Most often out of memory — 15 GB free, this job needs ~25 GB." |
| `3221225477` (`0xC0000005`) | access violation, same memory triage |
| `ERROR: algorithmic failure: src/diann.cpp: 39414` | "DIA-NN internal assertion. Not actionable directly — here is the log excerpt and a pre-filled issue report." |
| `WARNING: unrecognised option […]` | Surfaced as an error, not a warning — it means a flag was silently dropped |
| silence | Structured stage progress parsed from the log |

The log is captured to a bounded ring buffer in the UI and written to disk
append-and-flush, so **it survives the crash** — which today it does not
([D#626](https://github.com/vdemichev/DiaNN/discussions/626): *"Due to the
crash, I get no saved log"*).

---

# Part 2 — Reading DIA-NN results

Everything above is optional. A DIA-NN result folder produced anywhere — a
cluster, a collaborator, three years ago — opens with no engine installed at all.

## What a DIA-NN output folder contains

| File | Format | Required? | Use |
|---|---|---|---|
| `report.parquet` | Parquet | **yes** — the only hard requirement | Everything. Precursor × run with q-values, quantities, RT/IM, peak boundaries |
| `report.stats.tsv` | TSV | no | Per-run QC metrics; feeds the Runs grain |
| `report.pg_matrix.tsv` etc. | TSV | no | **Ignored** — derivable from the report, and two sources of truth is the bug |
| `report.protein_description.tsv` | TSV | no | Protein sequences → coverage view |
| `report.log.txt` | text | no | Settings provenance, parsed into the session card |
| `*.xic.parquet` | Parquet | no | Read if present, never required |
| library `.parquet` / `.speclib` | — | no | Fragment m/z; else theoretical b/y from the sequence |
| `.quant` | proprietary | — | Not readable. Only ever passed back to DIA-NN |

**`report.parquet` alone must produce a fully navigable session.** Everything
else upgrades the experience; nothing else gates it.

## The column contract

| Purpose | Columns |
|---|---|
| Identity | `Run`, `Precursor.Id`, `Modified.Sequence`, `Stripped.Sequence`, `Precursor.Charge`, `Precursor.Mz`, `Decoy`, `Proteotypic` |
| Inference | `Protein.Group`, `Protein.Ids`, `Protein.Names`, `Genes` |
| **Coordinates — the seek keys** | `RT`, `RT.Start`, `RT.Stop`, `IM`, `Predicted.RT`, `Predicted.IM`, `FWHM` |
| Confidence | `Q.Value`, `PEP`, `Global.Q.Value`, `Lib.Q.Value`, `PG.Q.Value`, `Global.PG.Q.Value`, `Protein.Q.Value` |
| Quantity | `Precursor.Quantity`, `Precursor.Normalised`, `Ms1.Area`, `PG.MaxLFQ`, `Genes.MaxLFQ`, `Genes.MaxLFQ.Unique` |
| Evidence | `Evidence`, `Mass.Evidence`, `Ms1.Profile.Corr`, `Averagine`, `Quantity.Quality`, `Empirical.Quality` |
| **Fragments** (needs `--export-quant`) | `Fr.N.Id`, `Fr.N.Quantity`, `Fr.N.Score`, `Best.Fr.Mz` |
| Peptidoform | `Peptidoform.Q.Value`, `PTM.Site.Confidence`, `Site.Occupancy.Probabilities`, `Protein.Sites` |

`RT.Start` / `RT.Stop` / `Precursor.Mz` / `IM` matter most: they are the seek
keys into the mzPeak file, and `RT.Start`/`RT.Stop` are what make every raw
query RT-bounded — which `docs/ARCHITECTURE.md` shows is the difference between
105 ms and 2.97 s.

**Schema drift is expected.** DIA-NN adds columns per release and gates some
behind Enterprise (`Profile.Before`, `PG.MaxLFQ.Empirical.Quality`). The loader
maps known columns to canonical names and carries unknown ones through as an
untyped bag the table can still display, sort and filter. It never fails on an
unrecognised column and never assumes one is present.

## One schema, two producers

OpenDIAlyzer writes the same logical table with the same canonical names, plus
`ODIA.`-prefixed columns for things DIA-NN has no equivalent of — per-fragment
scores, the nested-family arbitration group, the entrapment label, the
calibrated-FDR estimate.

One loader, one table model, one set of views. The engine is a provenance badge,
not a code path — and the UI already tolerates absent columns because DIA-NN
forces it to.

`// ponytail: no adapter layer, no plugin interface, no format registry.
// Two producers of one schema. Add the third when it exists.`

## Where interoperation stops

| Not supported | Why |
|---|---|
| Reading `.quant` | Proprietary, undocumented. We pass them back to DIA-NN, never parse them |
| Reading `.speclib` | Undocumented. Ask for the `.parquet` library, or fall back to theoretical fragments, flagged as such in the UI |
| Redistributing DIA-NN | Not permitted, and not wanted |
| DIA-NN's statistical `Analyse` tab | Already good and free. Export a clean matrix instead — `docs/UI-DESIGN.md` |
