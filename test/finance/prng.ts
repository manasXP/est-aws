// Shared by journal.property.test.ts (STR-021) and books.property.test.ts
// (STR-023): a hand-rolled deterministic seeded PRNG, since no
// property-testing library is installed in this repo (no fast-check in
// package.json).

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
