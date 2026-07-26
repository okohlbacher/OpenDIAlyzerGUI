//! OpenDIAlyzer data layer (Tauri port).
//!
//! The Rust rewrite of the TypeScript `src/` modules. Phase 0 covers the
//! variant consolidation and the report open + distinct-targets path; later
//! phases add filtering, tree building, and the raw/XIC engine.

pub mod report;
pub mod variant;
