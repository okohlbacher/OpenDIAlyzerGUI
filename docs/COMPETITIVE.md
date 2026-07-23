# Collated issues in the incumbent UIs

Evidence for every design decision in `docs/UI-DESIGN.md` and
`docs/WORKFLOW.md`. Two classes of evidence, kept separate on purpose:

- **A — provable from source or vendor documentation.** Cited to file:line or to
  a documentation section. Not disputable.
- **B — reported by users.** Cited to a link. Weight varies; frequency noted.

---

# Part A — provable

## A0. A provenance correction that matters to the whole project

**The DIA-NN GUI source vendored at `ext/diann/GUI/` is not the GUI that ships
with DIA-NN 2.6.1.** It is a substantially older build. This is verifiable, not
inferred:

- Controls in the shipped screenshot `ext/diann/GUI/GUI window 23.png` that
  exist **nowhere** in `Form1.Designer.cs`: `About`, `Skyline`, `Viewer`, `Raw`,
  `.d (TIMS)`, `XICs`, `Contaminants`, `Calibration lib`, `Predicted library`,
  `Detailed log`, the `Mode` combo, `Semi`, the five named variable-modification
  checkboxes, `Precursor charge range`, `MBR`, `Scoring`, `Proteotypicity`,
  `Machine learning`, `Quantification strategy: QuantUMS`, `Library generation`,
  `Speed: peak filtering`, `Speed: RT/IM filtering`, `Copy`/`Paste`/`Apply
  RegEx`, and the pipeline `Active`/`Status` columns.
- The source hardcodes `report.tsv` (`Form1.Designer.cs:1211`, `Form1.cs:131`);
  2.6.1 writes `report.parquet`.
- `Form1.cs:237` launches `DIA-NN-plotter.exe`; the string "plotter" appears
  **zero times** in the 2.6.1 `README.md`.
- The source saves pipelines with `BinaryFormatter` to `*.pipeline`
  (`Form1.cs:784`); 2.6.1 documents `.pipeline.json` and a `--pipeline` CLI flag.
- 14 flags the source emits are absent from the 2.6.1 README entirely
  (`--out-gene`, `--no-nn`, `--no-ifs-removal`, `--peak-center`, `--unimod4`,
  `--unimod35`, `--corr-diff`, `--learn-lib`, `--min-fr-corr`, `--min-gen-fr`,
  `--min-fr-mz`, `--max-fr-mz`, `--max-pr-mz`, `--f`).

**Consequence for the vault.** `vault/10-DIA-NN/DIA-NN source is not
published.md` lists *"GUI `Form1.cs` → the complete exposed parameter surface +
defaults"* as a reconstruction source. That is no longer true: it is the
parameter surface of an obsolete version. The current surface must be
reconstructed from `README.md` §*GUI settings reference* (L792–988) and the
screenshot. Everything in A1–A3 below is therefore evidence about **DIA-NN's
design lineage and habits**, not about the current binary — which is still
useful, because the pathologies are architectural and most survive into 2.x.

## A1. The parameter surface

Measured from `Form1.Designer.cs`:

| | |
|---|---|
| Designer-declared members | 100 |
| Controls placed in the visual tree | 98, all on one 1008 × 729 form |
| **User-settable value-bearing controls** | **47** |
| Controls hidden behind tabs, accordions or dialogs | **0** — there is no `TabControl` anywhere, and no `.Visible=false` or `.Enabled=false` in either file |
| Value-bearing controls with no tooltip | **19 of 47 (40 %)** |
| Distinct CLI flags reachable from the GUI | 51 |
| Flags documented in the 2.6.1 README | ~200 |

So the GUI exposes roughly **a quarter of the command-line surface**, and the
other three quarters are reachable only by typing into a free-text box.

Two tooltips are unfinished sentences shipped to users: *"Protein isoforms are
always grouped based on..."* (`:489`) and *"Quantification algortihms optimised
for..."* (`:638`, typo in original).

**→ Our answer:** four questions on the setup screen, everything else measured
or preset (`docs/WORKFLOW.md`). Not "fewer settings arranged better" — fewer
settings.

## A2. A quarter of the settings silently do nothing

The whole *Precursor ion generation* block is wrapped in `if (S.fasta_s != "")`
(`Form1.cs:361`), and its interior in
`if (S.use_lib_free_b || S.prosit_b || S.reannotate_b)` (`Form1.cs:377`).

On a **default configuration** — no FASTA, library search — **12 of 47
user-settable controls emit no flag at all**: protease, missed cleavages,
peptide length min/max, precursor m/z min/max, fragment m/z min/max, max
variable modifications, M oxidation, C carbamidomethylation, N-term M excision.

Nothing is greyed out. No warning is shown. The log does not say a setting was
ignored.

Worked example: checking **"M oxidation"** has an effect only if *(a FASTA is
loaded)* **and** *(one of three other checkboxes is ticked)* **and** *(max
variable modifications ≥ 1)* — three independent conditions, none visible
(`Form1.cs:361, 377, 393-396`).

**→ Our answer:** a control that cannot take effect is not rendered. If a preset
makes a parameter irrelevant, it disappears rather than lying.

## A3. Labels that do not describe what they do

| Label | Emitted flag | Problem |
|---|---|---|
| "Reduce memory usage (for very large databases)" | `--min-corr 1.0 --corr-diff 1.0` | Label states an outcome; flags are correlation thresholds |
| "Remove likely interferences" *(unchecked)* | `--int-removal 0` | Double inversion on a differently-named flag |
| "Quantification strategy" | bit-decoded: `idx≥2 → --peak-center`, `idx&1 → --no-ifs-removal` | Four labels onto two orthogonal flags, structure invisible |
| "Implicit protein grouping" = *genes* **(default)** | *nothing* | Default emits no flag; relies on an unstated CLI default |
| "Generate spectral library" | *nothing* | Not stored in `Settings` at all — a pure proxy for another text box |

Five checkboxes are inverted (`--no-batch-mode`, `--no-nn`, `--no-prot-inf`,
`--no-isotopes`, `--int-removal 0`), so the echoed command line **never mentions
a feature when it is switched on**. A user reading the log to understand their
own analysis cannot map it back to the GUI.

**→ Our answer:** the session card records every parameter with its value *and
its provenance* (preset / measured / user). One vocabulary, no inversions.

## A4. Undocumented magic characters in the escape-hatch box

```csharp
// Form1.cs:296-299
if (S.add_s[0] == '>') external = true;  // suppress ALL other flags
if (S.add_s[0] == '!') save_cfg = true;  // write cfg, launch nothing
```

A leading `>` turns the entire GUI into a generic process launcher: `--f`,
`--lib`, `--out` and every other flag are suppressed. A leading `!` writes the
command line to a file and returns without running. Neither is discoverable
from the UI, and neither appears in the tooltip.

Worse, the escape hatch is **silently ignored** by *Convert to .dia*: the
`opts` append at `Form1.cs:435` sits inside the `else` of `if (convert)`, while
the `>` / `!` prefixes are still honoured.

## A5. The GUI reads nothing back

Exhaustive file I/O in `Form1.cs`: the default output path, a temp-dir
existence check, writing the generated `--cfg`, saving the log, and the pipeline
binary round-trip. **There is no read of `report.tsv`, `*.stats.tsv`,
`*.genes.tsv`, any matrix, or the DIA-NN log.**

The three variables that look like results handles are path strings, built and
never opened:

```csharp
// Form1.cs:342-348
stats_file  = "\"" + report + ".stats.tsv\"";
report_file = "\"" + S.out_s + "\"";
pdf_file    = "\"" + report + ".pdf\"";
```

They are concatenated into an argument list for `DIA-NN-plotter.exe`
(`Form1.cs:233-253`), which is started fire-and-forget: the exit code is not
checked, the PDF is not verified to exist, and it is never opened or displayed.
There is no "open output folder" control anywhere.

Grep for `ProgressBar`, `DataGridView`, `Chart`, `WebBrowser`, `PictureBox`:
**zero hits**. The entire run-feedback surface is a read-only multiline
`TextBox`, three literal status strings (`"Not started"`, `"Running..."`,
`"Finished"`), and a recoloured button used as a status lamp. Completion is
detected by string-comparing one line of stdout:

```csharp
// Form1.cs:213-219
if (line == "Finished") { finished = true; ... }
```

**→ Our answer:** the analysis and the results view are one application over one
data model. Runs become browsable as they finish.

## A6. Bugs that shape user experience

Not nitpicks — each produces a support ticket:

| Behaviour | Source |
|---|---|
| **Answering "No" to *"Close tab? All progress will be lost"* still kills the run.** `kill()` sits outside the `if` | `Form1.cs:653-661` |
| **Clicking Run during a run disposes the live `Process` handle**, so `Exited` can never fire — the GUI shows "Running..." forever. `process.Dispose()` executes *before* the `if (running) return;` guard, and the guard is silent | `Form1.cs:489, 548, 289` |
| **stderr is discarded.** `RedirectStandardError` is never set, with `CreateNoWindow=true` and no console to inherit | `Form1.cs:308-312` |
| **Clearing the output path and pressing Run throws.** `Path.GetDirectoryName("")` raises `ArgumentException`; no validation, no try/catch | `Form1.cs:336` |
| **The generated cfg file has a constant name**, so two tabs launching large file lists race and each `diann.exe` reads whichever won | `Form1.cs:446` |
| **Aborting a pipeline still launches the PDF plotter** against a half-written report (`plot` defaults to true) | `Form1.cs:763` |
| **Cross-thread UI access on every default run** — `LogText.Text +=` from the exit handler without `Invoke` | `Form1.cs:245, 251, 252` |
| **All four `lock` statements are commented out**, leaving shared run state unsynchronised | `Form1.cs:57, 211, 287, 500, 749` |
| **The log `TextBox` is unbounded** — no truncation, no line cap. A long `--verbose 5` run accumulates the whole stdout stream | `Form1.Designer.cs:1284` |
| **Startup does a synchronous WMI query on the UI thread**, unguarded — if WMI is unavailable, the tab dies | `Form1.cs:122-123` |
| **Default output is the working directory**, write-protected for a `C:\Program Files` install — and the resulting error goes to the discarded stderr | `Form1.cs:130-131` |
| **Silent cross-control mutation.** Setting either mass accuracy forces the other to 20.0; range clamps rewrite the opposite spinner; unchecking "Generate spectral library" destroys a hand-typed output path; selecting a pipeline row replaces all 44 settings with no confirmation | `Form1.cs:586-594, 608-636, 815-828, 912-918` |

**→ Our answer, as hard rules:** a destructive confirm never acts on the
declined branch; concurrent-action guards precede any state mutation; stderr is
captured; the log is a bounded ring buffer; no control silently rewrites
another; every input is validated before launch, not during.

## A7. The architectural weakness — pre-materialised chromatograms

Documented by DIA-NN itself (`ext/diann/README.md`, *Spectra (XIC Viewer)*):

> the **XICs** option … By default … extract chromatograms for the library
> fragment ions only and within 10s from the elution apex. Use `--xic [N]` to
> set the retention time window … `--xic-theoretical-fr` to extract all charge 1
> and 2 y/b-series fragments … might require a significant amount of disk space.

Three decisions are frozen **before the run**, by a user who does not yet know
what they will need to look at:

1. whether chromatograms exist at all,
2. how wide an RT window,
3. library fragments only, or theoretical too.

Get any of them wrong and the remedy is re-running the analysis. And no setting
at all extracts evidence for a **candidate the engine rejected**, so *"why is my
peptide missing?"* has no answer at any price.

Skyline has the same shape with a different cost profile — raw data is imported
into `.skyd` cache files, and import time and cache size are its two most
persistent complaints (see Part B).

**→ This is the entire reason for the project.** mzPeak is a STORED ZIP of
Parquet facets: member offsets are directly addressable and row-group
statistics permit skipping to the row groups covering an **RT** window — 105 ms
for a bounded m/z × RT query on a 1.5 GB, 507 M-peak archive, measured. Nothing
is pre-decided because nothing is pre-extracted. (m/z itself is *not* indexed;
`docs/ARCHITECTURE.md` records the measurement and the consequence.)

---

# Part B — DIA-NN, user-reported

Corpus: **1,290 issues** and **4,946 issue comments** (2018-04 → 2026-07-22),
**622 discussions**, from `github.com/vdemichev/DiaNN`, plus the 2.6.1 README.

## B0. Read this before designing against DIA-NN

**A large part of the historical "DIA-NN shows you nothing" critique died between
April and June 2026.** Versions 2.5.0 / 2.5.1 / 2.6.0 / 2.6.1 shipped the Report
Window: Experiment Design with SDRF import/export, a QC Dashboard, a Filter tab,
an Interpret tab (differential abundance, PCA, CAMERA pathway analysis), the
Spectra XIC Viewer, and a Parquet browser — plus auto-generated methods text, a
re-executable JavaScript notebook, and a self-contained HTML export.

Attacking "DIA-NN only gives you a TSV" attacks a 2024 product. The openings
below are the ones that **survive 2.6.1**, and they are narrower and sharper.

## B1. Silent death — the most damaging pattern, and it survives

The primary user-facing error UI is a raw Windows NTSTATUS code. Still true in
July 2026: [#2024](https://github.com/vdemichev/DiaNN/issues/2024),
[#2021](https://github.com/vdemichev/DiaNN/issues/2021) (`3221226505` =
`0xC0000409`), [#1960](https://github.com/vdemichev/DiaNN/issues/1960),
[#1937](https://github.com/vdemichev/DiaNN/issues/1937) (`3221225477` =
`0xC0000005`). Internal assertions leak too — **40 distinct `src/diann.cpp` line
numbers** have been pasted by users into the tracker, against a closed source.

**The headline finding.** Frequency analysis over the maintainer's 2,631
comments — the most repeated sentences in the entire repository are *"how does
the log look like"* (14), *"can you please share the log"* (11), *"can you please
share the logs"* (9), *"can you please share the full log"* (8). **146 maintainer
replies (5.5 %) are a request for the log.**

The product's self-diagnosis is weak enough that *the author himself* cannot
diagnose a failure without the raw text log. On
[#1960](https://github.com/vdemichev/DiaNN/issues/1960) the diagnosis was:

> "Most likely out of RAM. Log shows only 15Gb were available when starting the
> analysis… I would suggest to just close some apps"

**DIA-NN had that number in its own log and did not act on it.** It could have
said "you have 15 GB free and this needs 25 GB". It said `3221225477`.

Related, and each its own design lesson:

- **Renaming a file changes your results.** [#1766](https://github.com/vdemichev/DiaNN/issues/1766) — filename → alphabetical order → run order → auto-calibration → *every identification changes*. Nothing warns.
- **One bad file kills 500.** [#1787](https://github.com/vdemichev/DiaNN/issues/1787) — dies on file 101 of 500, every time; the user bisected by hand. No per-file isolation, no partial output.
- **A folder name breaks the command line.** [#1917](https://github.com/vdemichev/DiaNN/issues/1917) — a directory containing `--` produces a malformed invocation and no output. Resolution: don't do that.

## B2. Long runs die at the aggregation step, with no checkpoint

The canonical case, [D#1710](https://github.com/vdemichev/DiaNN/discussions/1710):

```
[891:02] Cross-run analysis
[891:02] Reading quantification information: 10638 files
[896:52] Quantifying peptides
Killed
```

**14.9 hours of successful per-run work, every `.quant` file intact on disk,
then OOM on 256 GB at cross-run assembly. One word of output.** Same class:
[#899](https://github.com/vdemichev/DiaNN/issues/899) (15,620 files),
[D#1635](https://github.com/vdemichev/DiaNN/discussions/1635),
[D#626](https://github.com/vdemichev/DiaNN/discussions/626) — where *"due to the
crash, I get no saved log"*, i.e. the crash destroys the only diagnostic.

`.quant` reuse is the de-facto recovery mechanism (recommended in 37 issues) but
is a checkpoint by side effect, not by design:

| Constraint | Evidence |
|---|---|
| Settings must match, with an 8-item allowlist of exceptions to memorise | README |
| **The default configuration produces unsafe `.quant` files** — auto mass accuracy and auto scan window invalidate reuse, and both are on by default | [#1986](https://github.com/vdemichev/DiaNN/issues/1986), whose title *is* the warning text |
| Not portable across DIA-NN versions — 12 builds in 17 months | [D#494](https://github.com/vdemichev/DiaNN/discussions/494) |
| Opaque: *"No, .quant files cannot be accessed."* | [#452](https://github.com/vdemichev/DiaNN/issues/452) |
| Keyed by raw **filename string**, not content — recovery required fabricating empty `.raw` files with a PowerShell script | [#1909](https://github.com/vdemichev/DiaNN/issues/1909) |
| Silently written to the wrong directory if the first is unwritable → empty output | [#1814](https://github.com/vdemichev/DiaNN/issues/1814) |

**→ Our answer:** content-addressed intermediates, version-portable, inspectable,
and an aggregation stage restartable on its own — on a bigger machine (Phase 5).

## B3. The ranked "you set X wrong" list

Computed by regex over all 2,631 maintainer replies. This is the empirical
answer to *what do people get wrong, repeatedly*:

| Rank | Corrective advice | Replies |
|---|---|---|
| 1 | Install the right runtime (.NET 8 / MSFileReader / VC++ / Sciex DLLs) | **77** |
| 2 | Use `Reuse .quant` (recovery) | 37 |
| 3 | **Disable** MBR | 32 |
| 4 | Reduce variable modifications | 29 |
| 5 | **Fix mass accuracies — don't leave on auto** | 27 |
| 6 | Re-convert mzML with correct MSConvert settings | 25 |
| 7 | Generate the predicted library as a separate step | 24 |
| 8 | **Fix the scan window** | 20 |
| 9 | **Enable** MBR | 18 |
| 10 | Switch to low-RAM mode | 14 |

Two observations that shaped `docs/WORKFLOW.md`:

- **#3 and #9 are the same setting in opposite directions**, 50 combined
  interventions. MBR is a coin-flip the user cannot evaluate.
- **#5 and #8 are the auto/manual trap: the default is the setting the expert
  always tells you to change.** Auto is run-order-dependent, invalidates
  `.quant` reuse, and is the documented cause of quantms's irreproducibility
  ([#778](https://github.com/vdemichev/DiaNN/issues/778) — same version, same
  files, same container, different quantities; *"Order of files matters."*).

Also: [D#390](https://github.com/vdemichev/DiaNN/discussions/390) — on a
160-core machine the GUI caps threads at 40 and silently overrides the field.
The answer is *"Please use the --threads command"*, i.e. leave the GUI.

## B4. The results you can still not see in 2.6.1

Three constraints frozen before the run, from the README:

1. **You must have ticked XICs beforehand.** [#1637](https://github.com/vdemichev/DiaNN/issues/1637) — the cheapest recovery is re-running the second pass of the whole experiment. [D#879](https://github.com/vdemichev/DiaNN/discussions/879): *"Search twice, wait twice. Is it the right way?"* → *"Yes, need to run twice."*
2. **±10 s around an apex**, library fragments only unless you pay disk.
3. **Identified precursors only.** The old `--vis` made this explicit — [#442](https://github.com/vdemichev/DiaNN/issues/442):
   > singjc: "I supply all the peptides (~14,000)… but it only saves ~2,200"
   > vdemichev: **"Yes, --vis will only report identified precursors. Can however use some R or Python package to directly extract chromatograms from mzML."**

That last sentence is the competitive thesis in one line: **for negative
evidence, the official answer is to leave the tool.**

Worse, the picture is not the data the engine scored —
[#1717](https://github.com/vdemichev/DiaNN/issues/1717): XICs are extracted
*per cycle*, so on Astral they contain only every second MS2 spectrum while the
engine used all of them. For a viewer whose purpose is trust, that is
disqualifying. And multiplexed data has no chromatogram inspection at all, by
either route (XIC Viewer or the Skyline hand-off).

Peak-picking disputes have no in-product resolution path —
[D#869](https://github.com/vdemichev/DiaNN/discussions/869), 500 samples: the
user had to open **Skyline** to make the argument that the wrong peak was
integrated. There is no "show me the two candidate peaks and why this one won".

## B5. The report contradicts itself

- **You cannot reproduce DIA-NN's own matrix from DIA-NN's own report.** [#1056](https://github.com/vdemichev/DiaNN/issues/1056): 14,126 protein groups from the documented filters vs 13,121 in `pg_matrix.tsv`. The maintainer's first proposed filter did not reproduce it either. The working answer, three rounds in, included an **undocumented** hidden 0.05 run-specific protein FDR and a non-zero-quantity predicate.
- **TSV and Parquet carry different columns by design** — [#1105](https://github.com/vdemichev/DiaNN/issues/1105). Fragment-level quantities need `--export-quant`, another pre-run decision.
- **A documented, dated competitive loss.** [#1723](https://github.com/vdemichev/DiaNN/issues/1723): phospho outputs disagree across four files, thresholds hard-coded at 0.90/0.99. After seven weeks with no reply the reporter wrote: **"No, the problem hasn't been resolved, so we've had to continue using Spectronaut."**

## B6. Cross-platform — the largest addressable gap

**The entire 2.5/2.6 Report Window is a Windows .NET 8 desktop app, and it does
not currently launch under Wine.**
[#1815](https://github.com/vdemichev/DiaNN/issues/1815) has been open since
2025-12: the .NET Framework 4.7.2 → .NET 8 move broke the Wine path with a
mangled Unix-onto-Windows path, and the workaround produces a second failure
(`System.Management requires native modules from the .NET Framework`). A second
user on HPC + Apptainer reports the identical dead end. Unresolved.

Native Linux is a reduced build (no Sciex `.wiff`), macOS is unsupported, and
there is no official container image — [#1500](https://github.com/vdemichev/DiaNN/issues/1500),
open since 2025-04: *"Redistribution of any kind is unfortunately really
something we cannot enable at the moment"*, which keeps DIA-NN 2.x off Galaxy
and BioContainers entirely.

**So every Linux, HPC, cloud and macOS user is locked out of DIA-NN's entire
inspection layer** — and HPC is exactly where the large cohorts, and the
failures in B2, live.

## B7. Claims we must NOT repeat

Checked and **not** substantiated. Repeating these would be wrong and would make
the project look uninformed:

| Claim | Status |
|---|---|
| "Reddit r/proteomics says…" | Reddit was unreachable to the research; **zero** verified content |
| "There is a DIA-NN mailing list / Google Group" | **No such group exists.** Support is GitHub + one person's email |
| "DIA-NN has no way to save settings" | False — Pipeline panel, pipeline files, `--cfg`, and the exact command line printed to the log |
| "DIA-NN has no QC output" | False — `report.stats.tsv`, PDF reports, and the 2.5+ QC Dashboard |
| "DIA-NN has no chromatogram viewer" | **False since 2.5 (April 2026).** Only the *constraints* in B4 are fair game |
| "Disk-space blowups are a major complaint" | Only 4 threads. **RAM is the real story** |
| "The maintainer is unresponsive" | Emphatically false — 96.6 % response rate, 3.4 h median first response |

That last row deserves care. The weakness is the opposite of neglect: **53 % of
all issue comments are written by one person**, the top third-party answerer has
17, there are no labels, no issue templates, and 66 % of issues are never closed.
Usability is being held up by heroic manual support. That is a real
vulnerability, but describing it as neglect would be false.

---

# Part C — Spectronaut and Skyline

Spectronaut sources: the [Spectronaut 20 manual](https://biognosys.com/content/uploads/2025/06/Spectronaut-20-Manual.pdf)
(210 pp.) and Biognosys release notes. Skyline: skyline.ms support board,
tutorials and papers. A deeper Skyline mine is folded in separately.

## C1. What Spectronaut does well — and we should copy

| Pattern | Source |
|---|---|
| Results browsable **seconds after iRT calibration**, before the run finishes | manual p. 42 |
| **Manual edits are first-class and visible** — a hand icon marks every human-touched node; `Reset All Peaks` reverts | pp. 62–64 |
| **Recalculate, don't re-run**: FDR, protein inference, conditions and normalisation change without re-extraction | p. 182 |
| Library refinement *from inside results review* — staged, previewed live, then batch-committed with a **named version** | pp. 65–67 |
| Table ↔ plot filter coupling (candidates table ↔ volcano) | p. 70 |
| Degrades to viewer mode on licence expiry rather than holding results hostage | SN18 notes |

## C2. What Skyline does well — the drilldown gold standard

1. **One selection model, N synchronised views, bidirectional.** Selecting in the Targets tree repaints chromatograms, peak areas, RTs and the Document Grid; clicking a volcano point selects back into the tree.
2. **Keyboard-bound named views** — F7 peak areas, F8 retention times, F11 auto-zoom to best peak, Alt-3 document grid. Reviewers inspect thousands of peaks; every mouse trip is a tax.
3. **Synchronize Zooming** and **Synchronize Integration** as toggleable modes.
4. **`.skyd` caches all ~10 candidate peaks per chromatogram plus full peak statistics**, not just the winner — which is precisely what makes reintegration and imputation instant.
5. **Peak picking as an inspectable model**: mProphet score distributions, target/decoy separation, per-feature contributions, then re-apply.
6. **Peak Boundary Imputation (25.2)** — renders the cohort's best-scoring replicate's boundaries as a green ghost overlay on the run you are doubting.
7. **`.skyl` audit log** — every GUI *and* CLI mutation, human-readable XML, hash-linked to the document, with undo-to-here. Copied in `docs/ROADMAP.md` Phase 2.
8. **`.sky.view` separates UI state from data** and is explicitly deletable.

## C3. Traps to avoid, with evidence

| Trap | Evidence |
|---|---|
| **Hidden default filters.** Spectronaut's tree is identification-filtered by default and its own manual warns in bold: *"sometimes is not obvious that a filter is applied"* | manual p. 61 |
| **No autosave** on multi-hour work: *"Spectronaut will not save the analysis automatically"* | p. 61 |
| **Vendor-admitted drilldown sluggishness.** Box 11, *"you might find some processes to be a bit slow and the software not as responsive as hoped"*, with four workarounds — the telling one being **"group your data tree by precursor window"**, i.e. align traversal with the physical scan-group layout so reads go sequential | p. 64 |
| **Toggles with unbounded cost and no estimate.** Skyline let a user build a 4.9M-transition document, then take 20 h and 99 % of 32 GB ([rowId=51409](https://skyline.ms/announcements/home/support/thread.view?rowId=51409)); Overlap Deconvolution reached 41 % in three days ([rowId=36940](https://skyline.ms/announcements/home/support/thread.view?rowId=36940)) | |
| **Silent semantic changes between versions.** SN19: *"Spectronaut 19 uses only MS2 quantification for differential abundance. Previously, the default was to use both MS1 and MS2."* Same data, same "factory settings", different biology | SN19 notes |
| **Cross-run ID transfer with no UI provenance** → ~16 % of the *C. albicans* proteome reported in non-spiked samples at default settings | [J. Proteome Res.](https://pubs.acs.org/doi/10.1021/acs.jproteome.3c00671) |
| **Report schema churn breaks downstream tools.** MS-DAP maintains Spectronaut back-compatibility *"up to Spectronaut 6"* | [msdap userguide](https://github.com/ftwkoopmans/msdap/blob/master/doc/userguide.md) |
| **Reports large enough to OOM downstream tools** — 17–35 GB exports; `MSstatsBig` exists for this. R crashed on a Spectronaut report with 180 GB available | [MSstats thread](https://groups.google.com/g/msstats/c/bjbzYRqmldc) |
| **Native GUI handle exhaustion** — SN20.2 shipped *"warning to user when application is almost out of GUI handles"*. Do not build a drilldown on one native control per datapoint | SN20 notes |
| **A scale-out path that amputates features.** SNE Combine reaches 10,000 files but loses directDIA support, volcano/heatmap, pivot export and normalisation choice | manual p. 86 |
| **Lazy loading leaking into the interaction model.** Skyline: *"'Synchronize zooming' currently only works if all replicates have been loaded once."* | [rowId=71363](https://skyline.ms/home/support/announcements-thread.view?rowId=71363) |
| **Answering scale by extracting less.** Skyline's reply to *">100 GB per sample"* is to narrow targets and predict RT up front — the same pre-materialisation trap as DIA-NN's `--xic` | [rowId=63279](https://skyline.ms/announcements/home/support/thread.view?rowId=63279) |
| **Parallelism only in the CLI** — `--import-process-count` exists in SkylineRunner but not the GUI | [Parallel Import Performance](https://skyline.ms/wiki/home/software/Skyline/page.view?name=perf_scaling) |

## C4. Windows-only, three times over

| Tool | GUI platform |
|---|---|
| **Spectronaut** | Windows only. The Linux build is *command line only*; you must move the `.sne` back to Windows to view it. No macOS. |
| **Skyline** | *"Skyline is currently developed for Windows 10 and later."* Mac and Linux unsupported. |
| **DIA-NN 2.5/2.6 Report Window** | Windows .NET 8; broken under Wine since 2025-12 (B6) |

Three independent confirmations of the same gap. Cross-platform drilldown over a
portable, documented result format is **the largest uncontested opening in this
market**, and it is the reason the Electron/TypeScript choice is strategic
rather than merely convenient.

## C5. Skyline at scale — the finding that matters most

Mined from 837 skyline.ms support threads, all 542 `ProteoWizard/pwiz` GitHub
issues, and the full 1,039-row public export of Skyline's own LabKey tracker.
Current stable is **v26.1 (2026-02-26)**.

> Note: there is no stable 25.2. The Peak Imputation page is titled "25.2"
> because that was the *Skyline-daily* line; it reached stable in v26.1. Treat
> those features as five months old, not a year.

### The headline: the lab that builds Skyline does not use it this way

> **Mike MacCoss (PI), 2025-12-11:** *"One thing we do is only import a single
> batch into each skyline experiment at a time. We have a fair amount of
> experience with projects with >1000 samples… Each Skyline document imports the
> DIANN output and a batch ~80-96 samples… **It is pretty common for us to have
> 5-15 Skyline documents in a Panorama Folder** with a relatively large DIA
> project."*
> — [rowId=73583](https://skyline.ms/announcements/home/support/thread.view?rowId=73583)

He then directs the user off the GUI entirely, to `nf-skyline-dia-ms` and
`nf-dia-batch-correction`, conceding they *"require a slightly higher learning
curve than using the Windows GUI."*

**The one-document-per-study model is broken above roughly 100 runs, the
maintainers know it, and their answer is to shard by plate and reassemble in
Nextflow.** That is December 2025, not ancient history.

### The memory cliff — the single most useful sentence in the corpus

> **Nick Shulman:** *"Skyline is written in the C# programming language. When
> Windows does not have enough RAM to hold everything that a C# program needs,
> **things really do slow suddenly down by a factor of about a million**. This
> has to do with the way that the garbage collection algorithm requires
> periodically looking at all of the pieces of memory that are in use."*

Skyline does not degrade — it falls off a cliff, because the GC must walk the
whole heap. There is no spill-to-disk, no bounded working set, no streaming.
**A workbench with a bounded, out-of-core working set wins this outright and can
prove it with a benchmark.** This is the strongest single argument for the
architecture in `docs/ARCHITECTURE.md`, and it applies to us too: a WASM heap
has the same failure shape if we ever materialise a whole run.

### Measured breaking points

| Observation | Source |
|---|---|
| **1 TB `.skyd`**, 207 Lumos DIA runs; SkylineRunner import took **10 days**; the document then could not be reopened. Root cause: a **>2 billion candidate peak** hard limit, worked around with a private one-off installer for one user | [thread](https://skyline.ms/home/support/announcements-thread.view?entityId=50a9ed47-95ab-1037-b576-e465a39370af) |
| **66 GB `.skyd`** from 150 DDA runs; **~3 days to load**, then OOM. Still slow after upgrading to 256 GB | [thread](https://skyline.ms/home/support/announcements-thread.view?entityId=c59e25be-ea3d-1034-b8d6-a631c49513f4) |
| **~20 hours** to extract 4 M transitions from 35 DIA runs, thrashing at the **"Joining" step** | [thread](https://skyline.ms/home/support/announcements-thread.view?entityId=51006299-af17-1039-a3a0-e465a393713c) |
| 200+ raw files: `.skyd` took 20 min for the first files, **>5 h by the 170th** — superlinear in replicate count | support corpus |
| **Hard cap: never more than 12 files extracted at once**, regardless of core count. *"'Many' means the smaller of either 12 or half the number of logical processors"* | [2026-05-26](https://skyline.ms/home/support/announcements-thread.view?entityId=8f196eac-3b75-103f-ab1e-22f535567336) |
| 123 transitions of PASEF MS1 data consuming **>36 GB** — ~300 MB per transition | [thread](https://skyline.ms/home/support/announcements-thread.view?entityId=2b35808f-2427-1036-96fc-e465a39343b4) |
| Report export: **12 hours for 50,000 rows**, with a constant stall at 75–90 % *independent of row count* | [thread](https://skyline.ms/home/support/announcements-thread.view?entityId=13781997-9194-103a-b73f-22f535565250) |

Two architectural tells. **"Joining"** — merging per-replicate temporary caches
into one monolithic `.skyd` — is the peak-memory moment and the source of every
horror story above; Brendan MacLean floated per-replicate caches as a document
setting in 2019 and **it never shipped**. And parallelism is recommended as
*twelve separate OS processes* (`--import-process-count=12`) because in-process
threading is defeated by GC — an explicit architectural concession.

The report-export user's instinct is worth noting too: *"is the skyline data
accessible any other way? For example, can I write some custom SQL?"* The answer
is no — `.skyd` is opaque. Our answer is Parquet.

### Reopening really is slower than creating, and the architect said so

> **Brendan MacLean, 2018:** *"**It is not our intent to consume more memory
> loading a saved file**, and we have done a fair amount of optimizing this
> case, **but it still may be true**."*
> — [thread](https://skyline.ms/home/support/announcements-thread.view?entityId=0a1c73d4-f77f-1035-96fc-e465a39343b4)

### The peak picker is being replaced, in public

[#4306](https://github.com/ProteoWizard/pwiz/issues/4306) (open, filed
**2026-06-16 by the team**): *"the peak picker can select the dominant peak
rather than the smaller peak near a peptide's explicit retention time."*
**Skyline does not reliably respect an explicit RT** — a trust break for
targeted assays.

More telling, [#4046](https://github.com/ProteoWizard/pwiz/issues/4046):
MacCoss has implemented a complete replacement in a separate repo
([maccoss/osprey](https://github.com/maccoss/osprey)) — CWT consensus with
**pointwise median across transitions**, Tukey median polish, LOESS RT
alignment — described as *"dramatically better than the current valley-based
peak finder."*

Two lessons. **Cross-run consensus peak detection is the state of the art;
design for it rather than carrying a per-run valley picker.** And Osprey is
already reproducing the materialise-everything habit —
[#4393](https://github.com/ProteoWizard/pwiz/issues/4393) *"~120 GB on 82-file"*,
[#4398](https://github.com/ProteoWizard/pwiz/issues/4398) *"~18–37 GB"* cache.

### The audit log: ten failure modes, and we are copying it

`docs/ROADMAP.md` Phase 2 copies Skyline's `.skyl`. Here is exactly what to fix
— sourced from [PMC7520049](https://pmc.ncbi.nlm.nih.gov/articles/PMC7520049),
the release notes, and the tracker.

| # | Failure | Our fix |
|---|---|---|
| **F1** | **Opt-in, and undiscoverable.** The most common user question about `.skyl` is *"what is this file, can I delete it?"* | On by default, not optional |
| **F2** | **The tamper warning is dismissible — and support says to dismiss it.** Nick Shulman: *"you can safely ignore that warning"* | A mismatch is an error with a diff, not a dismissible toast |
| **F3** | **SHA-1**, and the paper concedes it *"would not prevent a determined adversary"* | SHA-256, Merkle-chained, optionally signed. **Never claim 21 CFR Part 11** |
| **F4** | **Not replayable.** *"The audit log was not designed to allow for automatic reproduction of a document state."* It is a diary | **The single biggest available upgrade.** Log a canonical, re-executable operation stream |
| **F5** | **Failed operations are logged and not rolled back** (internal #694) — the log can assert something that never happened | Log outcome, not intent |
| **F6** | **Noise.** *"Too much audit logging for Refine > Accept Peptides"* (#705) | Coalesce bulk operations into one entry with a count |
| **F7** | **CLI coverage was incomplete for six years** — headless runs were silent provenance holes until v24.1 | One code path for GUI and CLI from day one |
| **F8** | **Format churn**, plus a first year in which the log was truncated on crash | Versioned schema; append-and-flush |
| **F9** | **New subsystems under-logged** — drag-and-drop only fixed in v26.1 | Log at the state-diff layer, never per-handler |
| **F10** | **Leaks data** — entries embed pasted clipboard content | Explicit redaction pass before sharing |

Its genuinely good ideas, which we keep: sidecar **language-independent XML
rendered localised**; **two-level messages from one diff tree** (summary →
drill-down); and **server-side validation as a publication gate** — Panorama can
reject documents with invalid logs, which is the right enforcement point.

### The worst UX crime in the corpus

> *"MProphet selects the wrong peak group and so I have to manually integrate
> the correct one. However, when I retrain the model, **it ignores my manual
> integration**, although the box to overwrite it is not ticked."*

Hours of human curation destroyed by a checkbox that does not work. Interaction
rule 7 in `docs/UI-DESIGN.md` exists because of this.

### Two silently-wrong numbers that shipped for years

- **v26.1**: *"Deprecated 'Protein Abundance Transition Summed' and 'Transition Averaged' because their values were **erroneously being multiplied an extra time by the number of transitions**."* Every publication using those columns is wrong.
- **v26.1**: *"Fixed issue where **all replicates showed the same q-value** in .blib libraries built from DIA-NN search results."*

**Cross-validate aggregate columns against an independent implementation in CI.**
This is cheap and it is the difference between a tool scientists trust and one
that quietly corrupts their conclusions.

### Onboarding — the empirical what-people-get-wrong list

1. **Declare-before-use modifications.** *"Modifications for this peptide do not match current document settings"* is the most-repeated error string in the corpus. → Infer from the library and offer to add.
2. **Greyed-out transitions** mean non-quantitative, and nothing says so.
3. **No chromatograms extracted** — Full-Scan settings not matching the acquisition. → We measure it instead of asking.
4. **Hidden minimum-count rules** — dot-product needs ≥3 transitions, unstated; the field is just blank.
5. **Settings that subvert other settings.** Brendan on one of his own: *"a setting I have considered removing."* A user got 4.9 M transitions from it — his corrected document ran in **6.5 min/file on a five-year-old i7**.
6. **Hardware requirements** were asked for on the download page in 2018 and still are not there.
7. **Ten user-visible file extensions** (`.sky .skyd .sky.view .skyl .skyr .blib .slc .elib .imsdb .sky.zip`). The standard answer to everything is *"use File > Share"*.

Point 5 is the general lesson: **at least half of Skyline's performance problem
is a settings-discoverability problem.** A tool that validates configuration up
front and estimates cost before running eliminates a large fraction of this
entire support corpus — which is exactly interaction rule 9 and
`docs/WORKFLOW.md`'s four questions.

### Explicitly declined — the uncontested ground

| Request | Response |
|---|---|
| **Linux UI, even read-only** | *"There are no plans… **You shouldn't expect to see the Skyline UI even in a limited form running on any non-Windows system**."* — Brendan MacLean, 2017. Still true nine years on |
| **Native macOS** | Declined since ≥2015; answer is Parallels or dual-boot — and **dual-boot is impossible on Apple Silicon**, so the advice is obsolete for every Mac sold since 2020 |
| **>12 parallel files** | *"Skyline will never extract chromatograms from more than 12 files at once"* (2026) |
| **Per-replicate caches instead of one joined `.skyd`** | Floated by Brendan in 2019; never shipped |
| **Direct/SQL access to chromatogram data** | *"The format of that file is only understood by Skyline"* |
| **Scrolling chromatogram view for hundreds of replicates**; document-wide replicate ordering; annotation values on comparison axes | All requested 2025-07; absent from v26.1 |
| **Calculated columns in reports** | [#4417](https://github.com/ProteoWizard/pwiz/issues/4417), open — **18 years, no computed column** |
| **Colour-blind-safe Targets indicators** | Internal #941, filed and closed unimplemented. Red/green is the primary quality signal |

**Where they *are* investing in 2026:** AlphaPeptDeep with CUDA, Tide search, the
Osprey peak finder, and a **Skyline MCP server for LLM control**
([#4089](https://github.com/ProteoWizard/pwiz/issues/4089)). Not cross-platform,
not scale. Those remain uncontested — but note that Peak Imputation is
explicitly framed as *"better integration with DIA-NN"*, so **Skyline is
repositioning as the curation layer on top of DIA-NN, which is our niche.
Expect it to be defended.**

### What their moat actually is, and it is not software

Two people — Nick Shulman (1,037 responses) and Brendan MacLean (718) — carry
~85 % of all support, frequently answering **within the hour**, for fifteen
years. Plus 29 tutorials in three languages, re-screenshotted every release.

That is the real barrier to entry in this field, and no architecture diagram
substitutes for it. Any plan that assumes users will switch on technical merit
alone is wrong.

## C6. Two things to verify before quoting them publicly

- **Spectronaut pricing.** ~$6–7k/yr academic comes from one practitioner blog, not from Biognosys, who publish no price. Treat as unsourced.
- **Whether the free Spectronaut Viewer is genuinely unlimited.** The vendor page says free and unlimited; one 2025 post about the Bruker-bundled Lite edition says viewing needs a paid key. Conflicting, and load-bearing if we position against it.
