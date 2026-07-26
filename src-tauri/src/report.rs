//! Port of the load + distinct-targets path from `src/report.ts` and
//! `src/aggregate.ts`. Phase 0: read the columns the skeleton needs and
//! reproduce `distinctTargets()`. Filtering, tree, and the raw engine follow.

use std::collections::HashSet;
use std::fs::File;
use std::path::Path;
use std::time::Instant;

use arrow::array::{Array, StringArray};
use arrow::compute::cast;
use arrow::datatypes::DataType;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::ProjectionMask;
use serde::Serialize;

use crate::variant::target_of;

const PROTEIN_GROUP: &str = "Protein.Group";
const RUN: &str = "Run";

/// The loaded report, holding only what Phase 0 touches. Expanded in Phase 1.
pub struct Report {
    pub row_count: usize,
    pub column_names: Vec<String>,
    pub protein_group: Vec<String>,
    /// Distinct run names in first-appearance order (mirrors report.ts `runs`).
    pub runs: Vec<String>,
    pub load_ms: f64,
}

/// Shape returned to the webview by `open_report` — mirrors the Electron
/// `session:open` handler so the renderer sees an identical object.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub name: String,
    pub row_count: usize,
    pub columns: usize,
    pub runs: Vec<RunInfo>,
    pub extra: usize,
    pub missing: Vec<String>,
    pub load_ms: f64,
    pub scan_ms: f64,
    pub mbr: Option<bool>,
    pub paired: usize,
    pub found: usize,
}

#[derive(Serialize)]
pub struct RunInfo {
    pub name: String,
    /// Archive pairing is Phase 3 (needs the mzPeak registry scan); null for now.
    pub archive: Option<String>,
}

impl Report {
    pub fn load(path: &Path) -> Result<Report, String> {
        let t0 = Instant::now();
        let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        let builder =
            ParquetRecordBatchReaderBuilder::try_new(file).map_err(|e| format!("parquet: {e}"))?;

        let schema = builder.schema().clone();
        let column_names: Vec<String> =
            schema.fields().iter().map(|f| f.name().clone()).collect();

        let pg_idx = schema
            .index_of(PROTEIN_GROUP)
            .map_err(|_| format!("missing column {PROTEIN_GROUP}"))?;
        let run_idx = schema
            .index_of(RUN)
            .map_err(|_| format!("missing column {RUN}"))?;

        // Read only the two columns the skeleton needs, not the whole 50-wide row.
        let mask =
            ProjectionMask::roots(builder.parquet_schema(), [pg_idx, run_idx]);
        let reader = builder
            .with_projection(mask)
            .build()
            .map_err(|e| format!("reader: {e}"))?;

        let mut protein_group: Vec<String> = Vec::new();
        let mut runs: Vec<String> = Vec::new();
        let mut seen_runs: HashSet<String> = HashSet::new();
        let mut row_count = 0usize;

        for batch in reader {
            let batch = batch.map_err(|e| format!("batch: {e}"))?;
            row_count += batch.num_rows();
            let bs = batch.schema();
            let pg = read_strings(&batch, bs.index_of(PROTEIN_GROUP).unwrap())?;
            let rn = read_strings(&batch, bs.index_of(RUN).unwrap())?;
            for i in 0..batch.num_rows() {
                let r = &rn[i];
                if seen_runs.insert(r.clone()) {
                    runs.push(r.clone());
                }
                protein_group.push(pg[i].clone());
            }
        }

        Ok(Report {
            row_count,
            column_names,
            protein_group,
            runs,
            load_ms: t0.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// Every distinct target identity, sorted — mirrors `distinctTargets()`.
    /// Unfiltered by design: it lists what's searchable, not what passes the FDR
    /// slider.
    pub fn distinct_targets(&self) -> Vec<String> {
        let mut set: HashSet<&str> = HashSet::new();
        for pg in &self.protein_group {
            set.insert(target_of(pg));
        }
        let mut out: Vec<String> = set.into_iter().map(str::to_string).collect();
        out.sort();
        out
    }

    pub fn open_result(&self, name: String) -> OpenResult {
        OpenResult {
            name,
            row_count: self.row_count,
            columns: self.column_names.len(),
            runs: self
                .runs
                .iter()
                .map(|r| RunInfo { name: r.clone(), archive: None })
                .collect(),
            extra: 0,
            missing: Vec::new(),
            load_ms: self.load_ms,
            scan_ms: 0.0,
            mbr: None,
            paired: 0,
            found: 0,
        }
    }
}

/// Read a batch column as owned strings, robust to dictionary encoding.
fn read_strings(
    batch: &arrow::record_batch::RecordBatch,
    idx: usize,
) -> Result<Vec<String>, String> {
    let arr = batch.column(idx);
    let utf8 = cast(arr, &DataType::Utf8).map_err(|e| format!("cast utf8: {e}"))?;
    let s = utf8
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or("not a string column")?;
    Ok((0..s.len())
        .map(|i| if s.is_null(i) { String::new() } else { s.value(i).to_string() })
        .collect())
}
