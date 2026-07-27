import { describe, it, expect } from 'vitest';
import { computeGstTaxLines } from '../../aws-blocks/finance/receipts';
import { mulberry32 } from './prng';

// STR-077 -- computeGstTaxLines is a pure bigint-paise function, so unlike
// the other property tests in this directory (journal.property.test.ts,
// books.property.test.ts) it needs no Database/Scope/migrations.

describe('STR-077 property: GST tax-line rounding invariants (TC-FIN-025)', () => {
  // T-P1 (BE-P, covers TC-FIN-025): for any generated GST-inclusive total
  // (paise, across rounding-edge amounts), taxableAmount + cgstAmount +
  // sgstAmount equals the total exactly, and cgstAmount === sgstAmount
  // (even 9/9 split).
  it('taxable + cgst + sgst always sums exactly to the total, and cgst === sgst', () => {
    const rand = mulberry32(20260727);

    const totals: bigint[] = [
      1n, // smallest possible amount: 1 paisa
      118n, // divisible evenly by 118 -> no remainder
      119n, // remainder 1
      59n, // boundary where r*2n === b (59*2 === 118)
      100000000n, // a large realistic receipt total (10,00,000.00)
    ];

    // Fill out to ~200 generated cases spanning small and large amounts.
    while (totals.length < 200) {
      const magnitude = rand() < 0.5 ? 1 + Math.floor(rand() * 100000) : 1 + Math.floor(rand() * 100000000);
      totals.push(BigInt(magnitude));
    }

    for (const totalPaise of totals) {
      const { taxableAmount, cgstAmount, sgstAmount } = computeGstTaxLines(totalPaise);

      expect(taxableAmount + cgstAmount + sgstAmount).toBe(totalPaise);
      expect(cgstAmount).toBe(sgstAmount);
    }
  });

  // T-U1: a total that divides evenly by 1.18 (no rounding remainder) still
  // produces the exact-sum invariant -- asserted here against the literal
  // expected bigints since this is the "clean division" case with zero
  // leftover paisa to fold.
  it('produces the exact literal split for a total with no rounding remainder', () => {
    const result = computeGstTaxLines(11800n); // "118.00" total

    expect(result).toEqual({ taxableAmount: 10000n, cgstAmount: 900n, sgstAmount: 900n });
    expect(result.taxableAmount + result.cgstAmount + result.sgstAmount).toBe(11800n);
  });
});
