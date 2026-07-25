// STR-024: Indian financial year (Apr 1 – Mar 31) resolution — a reporting
// period concept the Admin API's book reads use, and (per the story's
// Refactor note) is shared beyond books: E07 (charge runs), E08 (receipt
// series per FY), and E11 (Tally export period selection) all key dates to
// the same FY boundaries.

export interface FinancialYear {
  /** Inclusive start date (Apr 1), YYYY-MM-DD. */
  start: string;
  /** Inclusive end date (Mar 31), YYYY-MM-DD. */
  end: string;
  /** e.g. '2026-27'. */
  label: string;
}

/** Resolves a date (YYYY-MM-DD) into its Indian financial year (Apr 1 - Mar 31). */
export function financialYearOf(date: string): FinancialYear {
  const [year, month] = date.split('-').map(Number);
  const startYear = month >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  return {
    start: `${startYear}-04-01`,
    end: `${endYear}-03-31`,
    label: `${startYear}-${String(endYear).slice(-2)}`,
  };
}
