// STR-067: the due-date reminder dispatch step, run right after the
// scheduled maintenance charge run (aws-blocks/payments/charges.ts,
// runMaintenanceChargeRun) completes. Mirrors aws-blocks/finance/journal.ts's
// style: a plain exported function over a Database, no HTTP concerns.
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import type { Charge } from './charges';
import type { PushAdapter, PushNotification } from '../notifications/push-adapter';
import { pgTextArray } from '../sql-array';

/**
 * Dispatches one due-date reminder push per registered device to every
 * member represented in `raisedCharges`. Takes the charge run's own
 * returned `Charge[]` as input -- the charges *newly raised by this call
 * only* (STR-061/STR-063) -- rather than running a fresh "SELECT due
 * charges" query. That's deliberate: STR-063's ON CONFLICT DO NOTHING
 * already makes a re-run of an already-completed period return `[]`, so
 * this function is simply never called with anything to dispatch on a
 * repeat run. No separate idempotency check (e.g. "have we already
 * reminded this member for this period?") is needed here -- the run's own
 * completion signal is the single source of truth both metrics and
 * reminders read (T-U3/AC3).
 */
export async function dispatchDueDateReminders(
  db: Database,
  adapter: PushAdapter,
  raisedCharges: Charge[],
): Promise<void> {
  const memberIds = [...new Set(raisedCharges.map(charge => charge.member_id))];
  if (memberIds.length === 0) return;

  const devices = await db.query<{ push_token: string }>(
    sql`SELECT push_token FROM registered_devices WHERE member_id = ANY(${pgTextArray(memberIds)}::text[])`,
  );

  const notification: PushNotification = {
    title: 'Maintenance due',
    body: 'Your maintenance charge is due -- open the app to pay.',
  };

  for (const device of devices) {
    await adapter.send(device.push_token, notification);
  }
}
