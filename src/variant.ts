/**
 * Parses this project's point-mutant variant accession convention:
 * <GENE>VAR<wildtype-residue><position><mutant-residue>. For example,
 * AGXTVARA210V is gene AGXT with the A210V substitution.
 *
 * Variant FASTA entries have no GN field, so DIA-NN reports no Genes value for
 * them. Recognising the accession is therefore the only narrow, reliable way
 * to recover their target without changing how ordinary protein groups behave.
 */
export interface VariantTag {
  gene: string;
  wildtype: string;
  position: number;
  mutant: string;
  /** The short form shown in the UI, e.g. "A210V". */
  code: string;
}

const VARIANT_RE = /^([A-Za-z0-9]+)VAR([A-Za-z])(\d+)([A-Za-z])$/;

/** Parses one Protein.Group value as a variant accession. */
export function parseVariant(proteinGroup: string): VariantTag | null {
  const match = VARIANT_RE.exec(proteinGroup);
  if (!match) return null;
  return {
    gene: match[1]!,
    wildtype: match[2]!,
    position: Number(match[3]),
    mutant: match[4]!,
    code: `${match[2]}${match[3]}${match[4]}`,
  };
}

/**
 * The target identity for one Protein.Group. Only the exact variant convention
 * is consolidated; every other value is returned byte-for-byte unchanged.
 */
export function targetOf(proteinGroup: string): string {
  return parseVariant(proteinGroup)?.gene ?? proteinGroup;
}
