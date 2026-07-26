// STR-061: the maintenance charge run's business logic, sitting between the
// `charges`/`charge_settings` tables (migrations/018_charges.sql) and the
// CronJob handler (aws-blocks/index.ts) -- kept separate so it's testable
// with a plain Database, no CronJob/event types touched at all (test/
// payments/charge-run.test.ts). Mirrors aws-blocks/finance/journal.ts's
// style: plain exported functions over a Database, no HTTP concerns (this
// story adds no HTTP route, hence no `-api.ts` suffix).
//
// `charges` itself predates this file (migrations/016_ownership_transfer.sql,
// STR-055, merged first) -- its `asset_id` on a returned `Charge` is built
// from the in-memory `BillableOwnership` this module already has on hand,
// never a stored column, so it stays in sync with STR-055's schema with no
// migration coupling beyond the ALTERs in 018_charges.sql.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, Logger, Metrics } from '@aws-blocks/blocks';
import { listBillableOwnerships } from '../assets/ownerships-api';
import type { MemberStatus } from '../members/members-api';
import { formatMoney, parseMoney } from '../money';

export type ChargeKind = 'maintenance' | 'late_fee';
export type ChargeStatus = 'due' | 'in_payment' | 'paid';

export interface ChargeRunPeriod {
  periodKey: string;
  dueDate: string;
}

/**
 * Resolves a CronJob's `scheduledTime` (UTC ISO timestamp) into the
 * `YYYY-MM` IST period key and IST due date the maintenance charge run
 * writes -- extracted out of the CronJob handler (aws-blocks/index.ts) so
 * STR-063's idempotent re-run and STR-065's late-fee run can key off the
 * same period resolution instead of each re-deriving it. Due on the same
 * IST calendar date the run executes -- no AC pins a different rule; an
 * N-days-out grace period is a later story's call.
 */
export function chargeRunPeriodFromScheduledTime(scheduledTime: string): ChargeRunPeriod {
  const scheduled = new Date(scheduledTime);
  const ist = new Date(scheduled.getTime() + 5.5 * 60 * 60 * 1000);
  const periodKey = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
  const dueDate = ist.toISOString().slice(0, 10);
  return { periodKey, dueDate };
}

export interface Charge {
  charge_id: string;
  member_id: string;
  ownership_id: string;
  asset_id: string;
  kind: ChargeKind;
  period_key: string;
  /** Always a decimal string via formatMoney, never a raw DB numeric. */
  amount: string;
  due_date: string;
  status: ChargeStatus;
  /** STR-065: only present on `late_fee` charges -- the overdue `maintenance`
   * charge this one was raised from. */
  source_charge_id?: string;
}

/** Thrown when the `charge_settings` singleton fee is still at its seeded
 * "0.00" default -- this story ships no HTTP endpoint to configure it (the
 * only way is a direct SQL `UPDATE`), so an unconfigured fee must surface as
 * a clear, named error rather than tripping the raw `charges.amount CHECK
 * (amount > 0)` constraint inside the Lambda. */
export class ChargeSettingsNotConfiguredError extends Error {
  constructor() {
    super('Maintenance fee is not configured — update the charge_settings singleton row before running the charge run.');
    this.name = 'ChargeSettingsNotConfiguredError';
  }
}

/**
 * Reads the singleton `charge_settings` row (migrations/018_charges.sql,
 * `id = 'default'`) -- single-society-per-deployment, so this is the one
 * maintenance fee, not a per-society config table. The `::text` cast avoids
 * the NUMERIC column round-tripping through a JS `number` (same pattern as
 * test/finance/journal.property.test.ts's own `SUM(amount)::text`).
 */
export async function getMaintenanceFee(db: Database): Promise<string> {
  const row = await db.queryOne<{ maintenance_fee: string }>(
    sql`SELECT maintenance_fee::text AS maintenance_fee FROM charge_settings WHERE id = 'default'`,
  );
  if (!row) throw new Error('charge_settings singleton row is missing — this should never happen outside manual intervention');
  const fee = formatMoney(parseMoney(row.maintenance_fee));
  if (fee === '0.00') throw new ChargeSettingsNotConfiguredError();
  return fee;
}

/** STR-065: the flat amount and grace period (in days past the source
 * charge's due date) that `runLateFeeSweep` applies -- both per-society,
 * alongside the maintenance fee (migrations/020_charges_late_fee.sql). */
export interface LateFeeConfig {
  amount: string;
  gracePeriodDays: number;
}

/**
 * Reads the same `charge_settings` singleton as `getMaintenanceFee`, but
 * unlike it, an unconfigured late fee is a legitimate steady state (AC2: no
 * config, no late fees), not an error -- `late_fee_amount IS NULL` returns
 * `null` rather than throwing.
 */
export async function getLateFeeConfig(db: Database): Promise<LateFeeConfig | null> {
  const row = await db.queryOne<{ late_fee_amount: string | null; late_fee_grace_period_days: number | null }>(
    sql`SELECT late_fee_amount::text AS late_fee_amount, late_fee_grace_period_days FROM charge_settings WHERE id = 'default'`,
  );
  if (!row || row.late_fee_amount === null || row.late_fee_grace_period_days === null) return null;
  return { amount: formatMoney(parseMoney(row.late_fee_amount)), gracePeriodDays: row.late_fee_grace_period_days };
}

/** Domain Model member lifecycle: `pending` accrues nothing; `active` and
 * `suspended` both accrue. `ceased` isn't named explicitly in this story's
 * ACs, but the Domain Model spec says "No new charges" for `ceased` --
 * excluded here too for consistency (a minor, defensible inference, not
 * scope creep). Exported standalone so STR-063/STR-065 can reuse the same
 * accrual-basis predicate rather than re-deriving it. */
const ACCRUING_STATUSES: ReadonlySet<MemberStatus> = new Set(['active', 'suspended']);
export function isAccruingStatus(status: MemberStatus): boolean {
  return ACCRUING_STATUSES.has(status);
}

/** STR-063 refactor: optional observability hooks for the run summary --
 * omitted entirely by STR-061's existing call sites/tests, which keep
 * passing unmodified with zero test changes. */
export interface ChargeRunObservability {
  log?: Logger;
  metrics?: Metrics;
}

/** STR-065 Refactor: one insert-if-absent charge writer shared by
 * `runMaintenanceChargeRun` and `runLateFeeSweep`, so future charge kinds
 * inherit the same idempotency and no-mutation guarantees. A bare `ON
 * CONFLICT DO NOTHING` (no arbiter column list) rather than naming a
 * specific constraint -- that form catches a violation of *any* applicable
 * unique/exclusion constraint on `charges`, so this one helper works
 * correctly against both the STR-063 (ownership_id, period_key, kind)
 * constraint (maintenance charges) and the STR-065 partial
 * (source_charge_id, period_key) index (late-fee charges) without needing to
 * know which one applies to a given insert. Returns whether a row was
 * actually inserted. */
async function insertChargeIfAbsent(
  db: Database,
  charge: { chargeId: string; memberId: string; ownershipId: string; kind: ChargeKind; periodKey: string; amount: string; dueDate: string; sourceChargeId?: string },
): Promise<boolean> {
  const result = await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, kind, period_key, amount, due_date, status, source_charge_id)
        VALUES (${charge.chargeId}, ${charge.memberId}, ${charge.ownershipId}, ${charge.kind}, ${charge.periodKey}, ${charge.amount}, ${charge.dueDate}, 'due', ${charge.sourceChargeId ?? null})
        ON CONFLICT DO NOTHING`,
  );
  return result.rowCount > 0;
}

/**
 * The pure, directly-testable core the CronJob handler (aws-blocks/index.ts)
 * calls -- no `event`/AWS types in this signature, so unit tests call it
 * directly without touching CronJob at all. Reads the billable-asset basis
 * (STR-053's listBillableOwnerships, no status filtering by design), filters
 * to accruing members in one member-status query (no per-ownership N+1),
 * and inserts one `maintenance` charge per remaining ownership whose
 * (ownership_id, period_key, kind) key isn't already present (STR-063:
 * idempotent re-run). The returned `Charge[]` is only the charges newly
 * raised by *this* call, not every charge for the period -- a re-run against
 * an already-complete period returns `[]`.
 */
export async function runMaintenanceChargeRun(
  db: Database,
  periodKey: string,
  dueDate: string,
  observability?: ChargeRunObservability,
): Promise<Charge[]> {
  const fee = await getMaintenanceFee(db);
  const billable = await listBillableOwnerships(db);

  const memberRows = await db.query<{ id: string; member_status: MemberStatus }>(sql`SELECT id, member_status FROM members`);
  const statusByMemberId = new Map(memberRows.map(row => [row.id, row.member_status]));

  const accruing = billable.filter(ownership => {
    const status = statusByMemberId.get(ownership.member_id);
    return status !== undefined && isAccruingStatus(status);
  });

  const charges: Charge[] = [];
  let skipped = 0;
  for (const ownership of accruing) {
    const chargeId = randomUUID();
    const inserted = await insertChargeIfAbsent(db, {
      chargeId,
      memberId: ownership.member_id,
      ownershipId: ownership.ownership_id,
      kind: 'maintenance',
      periodKey,
      amount: fee,
      dueDate,
    });
    if (!inserted) {
      skipped++;
      continue;
    }
    charges.push({
      charge_id: chargeId,
      member_id: ownership.member_id,
      ownership_id: ownership.ownership_id,
      asset_id: ownership.asset_id,
      kind: 'maintenance',
      period_key: periodKey,
      amount: fee,
      due_date: dueDate,
      status: 'due',
    });
  }

  observability?.log?.info('maintenance charge run summary', { periodKey, raised: charges.length, skipped });
  observability?.metrics?.emit('ChargesRaised', charges.length, { unit: 'Count' });
  observability?.metrics?.emit('ChargesSkipped', skipped, { unit: 'Count' });

  return charges;
}

/**
 * STR-065: the overdue sweep -- for each `maintenance` charge still `due`
 * and past its (per-society) grace period as of `dueDate` (the run's own
 * IST as-of date, the same parameter `runMaintenanceChargeRun` already
 * takes -- reused as "now" so this stays fully deterministic, never
 * `Date.now()`/`new Date()`), raises one `late_fee` charge linked to it via
 * `source_charge_id`. `kind = 'maintenance'` in the WHERE clause is what
 * enforces the spec's "no compounding" decision structurally: a `late_fee`
 * charge is never itself a candidate. Never updates the source charge row
 * -- only ever inserts a new one (AC1). Returns `[]` immediately, with no
 * charges and no error, when late fees aren't configured for this society
 * (AC2).
 */
export async function runLateFeeSweep(
  db: Database,
  periodKey: string,
  dueDate: string,
  observability?: ChargeRunObservability,
): Promise<Charge[]> {
  const lateFeeConfig = await getLateFeeConfig(db);
  if (!lateFeeConfig) return [];

  const overdue = await db.query<{ id: string; member_id: string; ownership_id: string; asset_id: string }>(
    sql`SELECT c.id, c.member_id, c.ownership_id, o.asset_id
        FROM charges c
        JOIN ownerships o ON o.id = c.ownership_id
        WHERE c.kind = 'maintenance'
          AND c.status = 'due'
          AND c.due_date + (${lateFeeConfig.gracePeriodDays} * INTERVAL '1 day') <= ${dueDate}::date`,
  );

  const charges: Charge[] = [];
  let skipped = 0;
  for (const source of overdue) {
    const chargeId = randomUUID();
    const inserted = await insertChargeIfAbsent(db, {
      chargeId,
      memberId: source.member_id,
      ownershipId: source.ownership_id,
      kind: 'late_fee',
      periodKey,
      amount: lateFeeConfig.amount,
      dueDate,
      sourceChargeId: source.id,
    });
    if (!inserted) {
      skipped++;
      continue;
    }
    charges.push({
      charge_id: chargeId,
      member_id: source.member_id,
      ownership_id: source.ownership_id,
      asset_id: source.asset_id,
      kind: 'late_fee',
      period_key: periodKey,
      amount: lateFeeConfig.amount,
      due_date: dueDate,
      status: 'due',
      source_charge_id: source.id,
    });
  }

  observability?.log?.info('late fee sweep summary', { periodKey, raised: charges.length, skipped });
  observability?.metrics?.emit('LateFeesRaised', charges.length, { unit: 'Count' });
  observability?.metrics?.emit('LateFeesSkipped', skipped, { unit: 'Count' });

  return charges;
}
