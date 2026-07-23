# Navigation — project, run, results

The application had two screens: Setup (which becomes Progress) and the
Workbench. Adding experiment design, library generation, a second engine and run
monitoring means a third, and it means saying plainly how a user moves between
them without building a wizard.

## The shape

```
  ┌──────────┐      ┌───────────┐      ┌──────────┐
  │ PROJECT  │ ───▶ │  ANALYSE  │ ───▶ │ RESULTS  │
  └──────────┘      └───────────┘      └──────────┘
       ▲                  │                  │
       └──────────────────┴──────────────────┘
            every arrow goes both ways, always
```

Three places, not three steps. **A project is openable at any stage and lands
where the work is** — a finished project opens on Results, a running one on
Analyse, a new one on Project. Nothing is gated: you can open Project mid-run to
correct a sample annotation, and you can reach Results the moment the first run
finishes.

This is the one thing a wizard gets wrong and the reason not to build one. The
incumbents' own users describe re-running analyses because a setting could not
be revisited without starting over.

## PROJECT — the experiment, before any parameters

The screen the application currently lacks. It answers *what is this experiment*,
which is a different question from *what shall I run*.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Liver PH1 cohort                          ⓘ 6 runs · 2 conditions   │
├──────────────────────────────────────────────────────────────────────┤
│  Files            ⊕ add   ⇢ import SDRF / ISA                        │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ run          organism part  disease      factor[group]  instr. │  │
│  │ S08_1305     liver          PH1          patient        timsTOF│  │
│  │ S23_1320     liver          PH1          patient        timsTOF│  │
│  │ S26_1323     liver          normal       control        timsTOF│  │
│  │ …                                            [+ column]        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  Description      free text, becomes the ISA study description        │
│  Sequences        human_reviewed.fasta            (20 431 entries)    │
│                                                                       │
│  ⚠ 2 runs have no value for factor[group]        [validate ▾]         │
└──────────────────────────────────────────────────────────────────────┘
```

### SDRF is the table, not a dialog

The rule from `docs/ROADMAP.md` Phase 3, unchanged: **SDRF columns are the run
table's columns, edited in place.** No import-then-diverge, no second editor.
Because design metadata sits in the same table model as everything else, a
factor value is immediately usable as a filter, a colour-by, and a submission
field.

Simplified means **the required columns are present and named as SDRF names
them**, with the rest addable. Not a reduced schema — a reduced *ceremony*.
`source name`, `characteristics[organism]`, `characteristics[organism part]`,
`characteristics[disease]`, `assay name`, `comment[instrument]`,
`comment[file uri]`, plus any `factor value[...]` the user adds.

**Validation is rows, not a modal.** A missing factor value marks that cell and
adds a line to the banner. It never blocks: an experiment can be analysed before
its annotation is finished, and forcing the order round would just teach people
to type placeholders.

### ISA sits above, and is thin

Investigation → Study → Assay. One project is one study; the assay table *is*
the SDRF above. The investigation layer holds title, description, contacts and
publication — four fields, not a schema editor. Anything more belongs in a real
ISA tool, and pretending otherwise would be the "library editor" mistake from
`docs/UI-DESIGN.md`.

## ANALYSE — parameters, library, engine, progress

Today's Screen 1, extended in three ways.

### Engine choice becomes real

`docs/DIANN-COMPAT.md` already defines the `Engine` interface with two
implementations. The screen gains a chooser only when more than one is
installed:

| | |
|---|---|
| **DIA-NN** | detected, verified, driven by the calibrate → per-run → aggregate plan |
| **OpenSWATH** | OpenMS tooling; needs a spectral library, so it cannot run library-free |

The important consequence: **OpenSWATH cannot search library-free**, so choosing
it makes the library a prerequisite rather than an option. The screen must say
that at the point of choosing, not fail later.

**How much the `Engine` interface actually shares, honestly.** The plan review
was right that one interface risks leaking. The two engines differ in every
concrete: OpenSWATH takes mzML (so a Bruker `.d` needs converting first),
consumes a `.pqp` assay library, runs as a chain of OpenMS tools
(`OpenSwathWorkflow` → `pyprophet` → `TRIC`) rather than one binary, and emits
an OSW/SQLite result, not `report.parquet`. What the interface *can* honestly
promise is narrow and worth keeping: `detect`, `verify`, `plan` (returning
inspectable stages), and `run` (spawn, stream, cancel). Everything downstream —
the assay-library conversion, the mzML conversion, the OSW→canonical-table
reader — lives inside the OpenSWATH implementation, not in the shared shape. The
interface is a lifecycle contract, not a claim that the engines are alike. If a
method starts needing an `if (engine === "openswath")` in shared code, that is
the signal the boundary was drawn wrong.

### Library generation is a separate, cacheable step

Currently folded into stage 0 of the DIA-NN plan. It becomes visible, because:

- it is the slow part (a predicted library for this cohort was ~1 GB and minutes
  of GPU-less prediction);
- DIA-NN's own documentation says to generate the library as a **separate run**
  — 24 maintainer replies say so;
- it is cacheable by (FASTA hash + digest parameters), which is only expressible
  if it is its own step.

```
  Sequences ─▶ [ generate library ]  ─▶  library ─┬─▶ DIA-NN
              or import an existing one           └─▶ OpenSWATH (after conversion)
```

**Correction (plan review).** An earlier draft said "the same library feeds both
engines". That is wrong, and glossing it would design in a lie. A DIA-NN
`.predicted.speclib` is a DIA-NN binary; OpenSWATH consumes a `.pqp`/`.tsv`
assay library built by its own tooling (`OpenSwathAssayGenerator` +
`OpenSwathDecoyGenerator`) with its own decoy model. Sharing "a library" means a
**conversion step per engine**, not one artifact — and the conversion is not
always lossless, since DIA-NN predicts fragments and iRT that OpenSWATH's format
represents differently. So the library step is cacheable per (FASTA, digest,
**engine**), and the OpenSWATH branch owns a converter. See the OpenSWATH
honesty note under "Two engines" below.

### Progress is the same surface, not a modal

Unchanged from `docs/WORKFLOW.md`: one line, expandable to per-run detail, with
the full log searchable and saved. Runs that finish become browsable
immediately — **Results opens on partial data and grows**, which the per-run
stage plan already makes true rather than merely presentational.

## RESULTS — today's workbench

Unchanged: scope / matches / evidence, with the grain selector.

**The join back to Project.** Once SDRF exists, its factor values become filters
and colour-bys in Results, and the Runs grain shows the annotation next to the
QC. That is the whole reason to do design first: a factor value typed once is
usable everywhere, and a cohort comparison stops being a spreadsheet exercise.

## Where things live

| | Project | Analyse | Results |
|---|---|---|---|
| what it answers | what is this experiment | what shall I run, and how is it going | what did we find |
| owns | SDRF/ISA, files, description | engine, library, preset, output, progress | filters, grains, evidence |
| needs | nothing | a project with files | a report |

One rule keeps it honest: **nothing is entered twice.** The run list is the
SDRF's rows; the SDRF's rows are the Runs grain; the Runs grain's QC is computed
from the same filtered set as everything else.

## Adversarial notes on this navigation

Written before implementation, as design-time attacks on the above.

**A project with no design must not be harder than one with.** The most common
first action is "I have six files, search them." If Project blocks that, people
will skip it and the design data never gets entered. So: dropping files creates
the SDRF rows automatically with everything but `source name` blank, and
Analyse is reachable immediately. Annotation is *additive*, never a gate.

**Import must not silently lose columns.** An imported SDRF carries columns we
do not model. They are kept and round-tripped verbatim; unknown columns are
displayed and editable, exactly as the report loader carries unknown columns
through.

**Two engines mean two provenance records, and they are not comparable.**
Switching engine after a run must not overwrite the previous result or make the
two look like one experiment. Each run is its own output directory and its own
provenance graph; Results shows which engine produced what, as the titlebar chip
already does.

**"Simplified editor" is where scope dies.** The temptation is ontology
lookup, term validation, unit handling, templates. The cut: **free text with
the correct column names, plus validation that reports rather than blocks.**
Ontology binding is Phase 3 proper and only worth it against a real submission.

**Progress that outlives the window.** A run is hours long. If closing the
window kills it, the design is wrong — hence sidecar subprocesses in
`docs/ARCHITECTURE.md`, and hence the per-run stage plan, which can be resumed
from whatever finished. This must be tested by killing the app mid-run, not
assumed.

**The back-arrow from Results to Project is the risky one.** Editing an SDRF
after analysis changes the meaning of a completed result. The rule: design edits
never mutate a finished run's provenance — they annotate the project, and
Results marks that its annotation has changed since the run.
