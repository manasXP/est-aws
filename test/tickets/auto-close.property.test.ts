import { describe, it, expect } from 'vitest';
import { isPastAutoCloseWindow, AUTO_CLOSE_DAYS } from '../../aws-blocks/tickets/lifecycle';
import { mulberry32 } from '../finance/prng';

// STR-122 — T-P1 (BE-P): the auto-close decision is a pure function of
// `resolved_at` and an injected clock, and agrees with `now >= resolved_at
// + 7d` at every offset — especially the ±1ms neighbourhood of the
// boundary, which is the epic's named auto-close risk ("a mis-scheduled job
// silently strands or prematurely closes tickets"). No property-testing
// library is installed (no fast-check in package.json); follows
// test/payments/charge-run.property.test.ts, reusing the shared seeded PRNG
// in test/finance/prng.ts.

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = AUTO_CLOSE_DAYS * DAY_MS;

describe('STR-122 property: isPastAutoCloseWindow matches now >= resolved_at + 7d exactly', () => {
  it('agrees with the reference predicate across randomised resolve times and clock offsets', () => {
    const random = mulberry32(0x7c1e7);

    for (let i = 0; i < 2000; i++) {
      // A resolve instant anywhere in a ~4-year span around the pilot.
      const resolvedAt = new Date(Date.UTC(2026, 0, 1) + Math.floor(random() * 4 * 365 * DAY_MS));
      // Offsets from -10d to +10d, so both sides of the window are covered.
      const offsetMs = Math.floor((random() * 20 - 10) * DAY_MS);
      const now = new Date(resolvedAt.getTime() + offsetMs);

      expect(isPastAutoCloseWindow(resolvedAt, now)).toBe(offsetMs >= WINDOW_MS);
    }
  });

  it('has no off-by-one at the boundary: exactly 7d closes, 1ms earlier does not', () => {
    const random = mulberry32(0xb0a4d);

    for (let i = 0; i < 500; i++) {
      const resolvedAt = new Date(Date.UTC(2026, 0, 1) + Math.floor(random() * 4 * 365 * DAY_MS));
      const boundary = resolvedAt.getTime() + WINDOW_MS;

      expect(isPastAutoCloseWindow(resolvedAt, new Date(boundary - 1))).toBe(false);
      expect(isPastAutoCloseWindow(resolvedAt, new Date(boundary))).toBe(true);
      expect(isPastAutoCloseWindow(resolvedAt, new Date(boundary + 1))).toBe(true);
    }
  });

  it('reads an ISO timestamp string identically to a Date (the DB returns either)', () => {
    const resolvedAt = new Date('2026-07-01T09:30:00.000Z');
    const boundary = new Date(resolvedAt.getTime() + WINDOW_MS);

    expect(isPastAutoCloseWindow(resolvedAt.toISOString(), boundary)).toBe(true);
    expect(isPastAutoCloseWindow(resolvedAt.toISOString(), new Date(boundary.getTime() - 1))).toBe(false);
  });
});
