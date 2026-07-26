import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { runMaintenanceChargeRun, runLateFeeSweep } from '../../aws-blocks/payments/charges';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';
import { formatMoney, parseMoney, sumMoney } from '../../aws-blocks/money';
import { mulberry32 } from '../finance/prng';

// STR-065 — T-P1 (BE-P): across a run sequence, at most one late-fee charge
// exists per (overdue source charge, period), and no run ever mutates a
// pre-existing charge row. Mirrors test/payments/charge-run-idempotency.
// property.test.ts's shape (same basis-generation approach, same seeded
// PRNG, same re-run-N-times idea) applied to runLateFeeSweep instead of
// runMaintenanceChargeRun.

const cleanupDbs: Database[] = [];

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

const MAINTENANCE_FEE = '2500.00';
const LATE_FEE_AMOUNT = '150.00';
const GRACE_PERIOD_DAYS = 5;

describe('STR-065 property: at most one late fee per (source charge, period); source charges never mutated', () => {
  it('re-running the sweep for the same period any number of times raises each eligible late fee exactly once, and leaves every source "due" charge row byte-for-byte unchanged', async () => {
    const db = new Database(new Scope(`str-065-prop-test-${randomUUID()}`), 'db');
    cleanupDbs.push(db);
    await runLocalMigrations(db, MIGRATIONS_DIR);
    await db.execute(sql`UPDATE charge_settings SET maintenance_fee = ${MAINTENANCE_FEE} WHERE id = 'default'`);
    await db.execute(
      sql`UPDATE charge_settings SET late_fee_amount = ${LATE_FEE_AMOUNT}, late_fee_grace_period_days = ${GRACE_PERIOD_DAYS} WHERE id = 'default'`,
    );

    const project = await createProject(db, { name: 'Green Meadows' });
    const rand = mulberry32(20260726);

    const MEMBER_COUNT = 6;

    // One accruing member per asset, each raising exactly one "maintenance"
    // source charge well past its grace period by the sweep's as-of date.
    const memberIds: string[] = [];
    for (let i = 0; i < MEMBER_COUNT; i++) {
      const member = await createMember(db, { name: `Member ${i}` });
      await admitMember(db, member.member_id);
      const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: `A-${i}` });
      await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
      memberIds.push(member.member_id);
    }

    const sourceCharges = await runMaintenanceChargeRun(db, '2026-01', '2026-01-05');
    expect(sourceCharges).toHaveLength(MEMBER_COUNT);

    // A random subset of the source charges is already settled -- these
    // must never attract a late fee no matter how overdue.
    const settledIds = new Set<string>();
    for (const charge of sourceCharges) {
      if (rand() < 0.3) {
        settledIds.add(charge.charge_id);
        await db.execute(sql`UPDATE charges SET status = 'paid' WHERE id = ${charge.charge_id}`);
      }
    }
    const eligibleCount = sourceCharges.length - settledIds.size;
    expect(eligibleCount).toBeGreaterThan(0);

    const beforeRows = await db.query<{ id: string; amount: string; status: string; due_date: string; period_key: string }>(
      sql`SELECT id, amount::text AS amount, status, due_date::text AS due_date, period_key FROM charges ORDER BY id`,
    );

    const firstRun = await runLateFeeSweep(db, '2026-07', '2026-07-15');
    expect(firstRun).toHaveLength(eligibleCount);
    for (const lateFee of firstRun) {
      expect(lateFee.amount).toBe(LATE_FEE_AMOUNT);
      expect(settledIds.has(lateFee.source_charge_id!)).toBe(false);
    }
    expect(sumMoney(firstRun.map(c => c.amount))).toBe(formatMoney(parseMoney(LATE_FEE_AMOUNT) * BigInt(eligibleCount)));

    const n = 1 + Math.floor(rand() * 4); // 1..4 extra re-runs of the same period
    for (let i = 0; i < n; i++) {
      const rerun = await runLateFeeSweep(db, '2026-07', '2026-07-15');
      expect(rerun).toHaveLength(0);
    }

    const lateFeeRows = await db.query<{ source_charge_id: string; period_key: string }>(
      sql`SELECT source_charge_id, period_key FROM charges WHERE kind = 'late_fee'`,
    );
    expect(lateFeeRows).toHaveLength(eligibleCount);
    const keys = lateFeeRows.map(r => `${r.source_charge_id}:${r.period_key}`);
    expect(new Set(keys).size).toBe(keys.length); // at most one per (source, period)

    // The original "due"/"paid" charge rows compare byte-for-byte equal to
    // their pre-sweep snapshot -- no run ever mutates a source charge.
    const afterRows = await db.query<{ id: string; amount: string; status: string; due_date: string; period_key: string }>(
      sql`SELECT id, amount::text AS amount, status, due_date::text AS due_date, period_key FROM charges WHERE kind = 'maintenance' ORDER BY id`,
    );
    expect(afterRows).toEqual(beforeRows);
  });
});
