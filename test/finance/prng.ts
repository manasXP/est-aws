// Shared by journal.property.test.ts (STR-021), books.property.test.ts
// (STR-023), and tally-export.property.test.ts (STR-102): a hand-rolled
// deterministic seeded PRNG, since no property-testing library is installed
// in this repo (no fast-check in package.json).
import type { PostingLine } from '../../aws-blocks/finance/journal';
import { formatMoney } from '../../aws-blocks/money';

// Deterministic seeded PRNG — mulberry32. Never used to generate money
// values via `number` arithmetic; only to pick integer paise amounts and
// structural choices (line counts, which side to perturb).
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split `total` paise into `parts` positive bigint pieces summing exactly to `total`. */
export function splitPaise(total: bigint, parts: number, rand: () => number): bigint[] {
  const amounts: bigint[] = new Array(parts).fill(1n);
  let remaining = total - BigInt(parts);
  while (remaining > 0n) {
    const idx = Math.floor(rand() * parts);
    amounts[idx] += 1n;
    remaining -= 1n;
  }
  return amounts;
}

/**
 * STR-021's posting generator, moved here (from journal.property.test.ts)
 * per STR-102's Refactor note so tally-export.property.test.ts can share it
 * rather than writing a second one. `balanced` is `true` ~70% of the time;
 * a caller that only wants valid postings (the only kind that ever reaches
 * `journal_entries`) should filter to `balanced` ones.
 */
export interface GeneratedPosting {
  balanced: boolean;
  lines: PostingLine[];
}

export function generatePosting(rand: () => number): GeneratedPosting {
  const totalPaise = BigInt(1 + Math.floor(rand() * 5000)); // 0.01 .. 50.00
  const debitParts = 1 + Math.floor(rand() * 2); // 1 or 2 lines
  const creditParts = 1 + Math.floor(rand() * 2);
  const debitAmounts = splitPaise(totalPaise, debitParts, rand);
  const creditAmounts = splitPaise(totalPaise, creditParts, rand);

  const balanced = rand() < 0.7;
  if (!balanced) {
    // Perturb the last credit line by +1 paise so debits != credits.
    creditAmounts[creditAmounts.length - 1] += 1n;
  }

  const accounts = ['cash', 'bank'];
  const lines: PostingLine[] = [
    ...debitAmounts.map((paise, i) => ({
      accountId: accounts[i % accounts.length],
      direction: 'debit' as const,
      amount: formatMoney(paise),
    })),
    ...creditAmounts.map((paise, i) => ({
      accountId: accounts[(i + 1) % accounts.length],
      direction: 'credit' as const,
      amount: formatMoney(paise),
    })),
  ];

  return { balanced, lines };
}
