//! Headless Phase-0 gate: same data path as the app, no window. Confirms the
//! Rust reader reproduces the TypeScript ground truth on the real dataset.
//!
//! Ground truth (from the TS side): 377775 rows, 16133 distinct targets,
//! AGXT present, AGXT2 absent.

use std::path::PathBuf;
use std::process::exit;

use opendialyzer_core::report::Report;

fn main() {
    // The dataset is unpublished and lives outside the repository.
    let Some(path) = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("ODIA_TEST_REPORT").ok())
        .map(PathBuf::from)
    else {
        eprintln!("usage: verify <report.parquet>   (or set ODIA_TEST_REPORT)");
        exit(2);
    };

    let report = match Report::load(&path) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("load failed: {e}");
            exit(2);
        }
    };
    let targets = report.distinct_targets();
    let has_agxt = targets.iter().any(|t| t == "AGXT");
    let has_agxt2 = targets.iter().any(|t| t == "AGXT2");

    println!("rows: {}", report.row_count);
    println!("columns: {}", report.column_names.len());
    println!("runs: {}", report.runs.len());
    println!("distinct targets: {}", targets.len());
    println!("AGXT present?  {has_agxt}");
    println!("AGXT2 present? {has_agxt2}");
    println!("load_ms: {:.1}", report.load_ms);

    let ok = report.row_count == 377775 && targets.len() == 16133 && has_agxt && !has_agxt2;
    println!("\nPhase-0 gate: {}", if ok { "PASS" } else { "FAIL" });
    if !ok {
        exit(1);
    }
}
