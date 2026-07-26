//! Port of `src/variant.ts`.
//!
//! Parses this project's point-mutant accession convention
//! `<GENE>VAR<wt><pos><mut>` (e.g. `AGXTVARA210V` = gene AGXT, A210V). Variant
//! FASTA entries carry no GN field, so DIA-NN reports no Genes value for them;
//! recognising the accession is the only reliable way to recover their target
//! without changing how ordinary protein groups behave.

use std::sync::LazyLock;

use regex::Regex;

static VARIANT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9]+)VAR([A-Za-z])(\d+)([A-Za-z])$").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantTag {
    pub gene: String,
    pub wildtype: String,
    pub position: u32,
    pub mutant: String,
    /// The short form shown in the UI, e.g. "A210V".
    pub code: String,
}

/// Parses one Protein.Group value as a variant accession.
pub fn parse_variant(protein_group: &str) -> Option<VariantTag> {
    let c = VARIANT_RE.captures(protein_group)?;
    let wildtype = c.get(2).unwrap().as_str().to_string();
    let position = c.get(3).unwrap().as_str();
    let mutant = c.get(4).unwrap().as_str().to_string();
    Some(VariantTag {
        gene: c.get(1).unwrap().as_str().to_string(),
        code: format!("{wildtype}{position}{mutant}"),
        position: position.parse().unwrap(),
        wildtype,
        mutant,
    })
}

/// The target identity for one Protein.Group. Only the exact variant convention
/// is consolidated; every other value is returned unchanged.
pub fn target_of(protein_group: &str) -> &str {
    match VARIANT_RE.captures(protein_group) {
        Some(c) => c.get(1).unwrap().as_str(),
        None => protein_group,
    }
}

/// True only when the full Protein.Ids candidate list contains one entry. A
/// variant-shaped Protein.Group is merely DIA-NN's representative pick when this
/// list also contains the wildtype or another variant, so it is not diagnostic
/// for that specific substitution.
pub fn is_diagnostic(protein_ids: &str) -> bool {
    let t = protein_ids.trim();
    !t.is_empty() && !t.contains(';')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_consolidates() {
        let v = parse_variant("AGXTVARA210V").unwrap();
        assert_eq!(v.gene, "AGXT");
        assert_eq!(v.code, "A210V");
        assert_eq!(v.position, 210);
        assert_eq!(target_of("AGXTVARA210V"), "AGXT");
        // Ordinary and multi-gene groups pass through byte-for-byte.
        assert_eq!(target_of("P21549"), "P21549");
        assert_eq!(target_of("AGXT2"), "AGXT2");
        assert!(parse_variant("P21549").is_none());
    }

    #[test]
    fn diagnostic_needs_a_single_candidate() {
        assert!(is_diagnostic("AGXTVARA210V"));
        assert!(is_diagnostic(" AGXTVARA210V "));
        assert!(!is_diagnostic("AGXTVARA210V;P21549"));
        assert!(!is_diagnostic(""));
        assert!(!is_diagnostic("   "));
    }
}
