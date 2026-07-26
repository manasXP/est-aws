// STR-061: the maintenance charge run's business logic, sitting between the
// `charges`/`charge_settings` tables (migrations/016_charges.sql) and the
// CronJob handler (aws-blocks/index.ts) -- kept separate so it's testable
// with a plain Database, no CronJob/event types touched at all (test/
// payments/charge-run.test.ts). Mirrors aws-blocks/finance/journal.ts's
// style: plain exported functions over a Database, no HTTP concerns (this
// story adds no HTTP route, hence no `-api.ts` suffix).
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
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
}

/**
 * Reads the singleton `charge_settings` row (migrations/016_charges.sql,
 * `id = 'default'`) -- single-society-per-deployment, so this is the one
 * maintenance fee, not a per-society config table. The `::text` cast avoids
 * the NUMERIC column round-tripping through a JS `number` (same pattern as
 * test/finance/journal.property.test.ts's own `SUM(amount)::text`).
 */
export async function getMaintenanceFee(db: Database): Promise<string> {
  const row = await db.queryOne<{ maintenance_fee: string }>(
    sql`SELECT maintenance_fee::text AS maintenance_fee FROM charge_settings WHERE id = 'default'`,
  );
  return formatMoney(parseMoney(row!.maintenance_fee));
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

/**
 * The pure, directly-testable core the CronJob handler (aws-blocks/index.ts)
 * calls -- no `event`/AWS types in this signature, so unit tests call it
 * directly without touching CronJob at all. Reads the billable-asset basis
 * (STR-053's listBillableOwnerships, no status filtering by design), filters
 * to accruing members in one member-status query (no per-ownership N+1),
 * and inserts one `maintenance` charge per remaining ownership.
 */
export async function runMaintenanceChargeRun(db: Database, periodKey: string, dueDate: string): Promise<Charge[]> {
  const fee = await getMaintenanceFee(db);
  const billable = await listBillableOwnerships(db);

  const memberRows = await db.query<{ id: string; member_status: MemberStatus }>(sql`SELECT id, member_status FROM members`);
  const statusByMemberId = new Map(memberRows.map(row => [row.id, row.member_status]));

  const accruing = billable.filter(ownership => {
    const status = statusByMemberId.get(ownership.member_id);
    return status !== undefined && isAccruingStatus(status);
  });

  const charges: Charge[] = [];
  for (const ownership of accruing) {
    const chargeId = randomUUID();
    await db.execute(
      sql`INSERT INTO charges (id, member_id, ownership_id, asset_id, kind, period_key, amount, due_date, status)
          VALUES (${chargeId}, ${ownership.member_id}, ${ownership.ownership_id}, ${ownership.asset_id}, 'maintenance', ${periodKey}, ${fee}, ${dueDate}, 'due')`,
    );
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
  return charges;
}
