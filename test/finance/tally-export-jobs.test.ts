import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database, FileBucket } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import {
  getLedgerAccountsForPeriod,
  getPostingsInPeriod,
  buildLedgerMastersXml,
  buildDayBookVouchersXml,
} from '../../aws-blocks/finance/tally-export';
import {
  startTallyExport,
  processTallyExport,
  TALLY_EXPORT_XML_SEPARATOR,
} from '../../aws-blocks/finance/tally-export-jobs';

// STR-103 — E11's assembly: the export_jobs lifecycle behind the Tally
// export AsyncJob (TC-FIN-042). Unit-level (BE-U): every case runs directly
// against startTallyExport/processTallyExport, not through the AsyncJob
// wiring in aws-blocks/index.ts (which, like STR-096's reconciliation job,
// is a one-line composition of the functions tested here). Test setup
// follows the STR-111 pattern: fresh Database + Scope + FileBucket per test,
// migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-103-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-103-test-${randomUUID()}`), 'documents');
  cleanupBuckets.push(bucket);
  return bucket;
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
  while (cleanupBuckets.length) {
    const bucket = cleanupBuckets.pop()!;
    rmSync(`.bb-data/${bucket.fullId}`, { recursive: true, force: true });
  }
});

/** Captures what startTallyExport submits without running a real queue --
 * the AsyncJob wiring itself is a one-liner in aws-blocks/index.ts. */
function stubQueue() {
  const submitted: { exportId: string }[] = [];
  return {
    submitted,
    queue: {
      submit: async (payload: { exportId: string }) => {
        submitted.push(payload);
        return { jobId: randomUUID() };
      },
    },
  };
}

interface ExportJobRow {
  status: string;
  document_path: string | null;
  completed_at: string | Date | null;
  failure_reason: string | null;
}

async function exportJobRow(db: Database, exportId: string): Promise<ExportJobRow> {
  const row = await db.queryOne<ExportJobRow>(
    sql`SELECT status, document_path, completed_at, failure_reason FROM export_jobs WHERE id = ${exportId}`,
  );
  return row!;
}

describe('STR-103 T-U1 (TC-FIN-042) — successful export processing', () => {
  it('drives a queued job to completed, storing exactly the STR-101 masters + STR-102 vouchers for the period', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await postJournalEntry(db, 'in-period maintenance receipt', [
      { accountId: 'bank', direction: 'debit', amount: '1500.00' },
      { accountId: 'cash', direction: 'credit', amount: '1500.00' },
    ], { postedAt: '2026-06-15T10:00:00Z' });
    await postJournalEntry(db, 'in-period cash expense', [
      { accountId: 'cash', direction: 'debit', amount: '250.00' },
      { accountId: 'bank', direction: 'credit', amount: '250.00' },
    ], { postedAt: '2026-07-01T09:00:00Z' });

    const { queue, submitted } = stubQueue();
    const job = await startTallyExport(db, queue, '2026-04-01', '2027-03-31');

    expect(job.status).toBe('queued');
    expect(submitted).toEqual([{ exportId: job.exportId }]);
    const queued = await exportJobRow(db, job.exportId);
    expect(queued.status).toBe('queued');
    expect(queued.document_path).toBeNull();

    await processTallyExport(db, bucket, job.exportId);

    const completed = await exportJobRow(db, job.exportId);
    expect(completed.status).toBe('completed');
    expect(completed.document_path).toBe(`tally-exports/${job.exportId}.xml`);
    expect(completed.completed_at).not.toBeNull();
    expect(completed.failure_reason).toBeNull();

    // The stored document must be the two STR-101/102 generators' output
    // verbatim -- computed independently here, never hardcoded XML.
    const expected =
      buildLedgerMastersXml(await getLedgerAccountsForPeriod(db, '2026-04-01', '2027-03-31')) +
      TALLY_EXPORT_XML_SEPARATOR +
      buildDayBookVouchersXml(await getPostingsInPeriod(db, '2026-04-01', '2027-03-31'));
    const stored = await bucket.get(completed.document_path!);
    expect(stored!.body.toString('utf-8')).toBe(expected);
  });
});

describe('STR-103 T-U2 (TC-FIN-042) — storage failure lands the job in failed', () => {
  it('passes through running, records the error message as failure_reason, and stores nothing', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await postJournalEntry(db, 'in-period posting', [
      { accountId: 'bank', direction: 'debit', amount: '100.00' },
      { accountId: 'cash', direction: 'credit', amount: '100.00' },
    ], { postedAt: '2026-06-15T10:00:00Z' });

    const { queue } = stubQueue();
    const job = await startTallyExport(db, queue, '2026-04-01', '2027-03-31');

    // The forced storage failure also observes the row's status at the
    // moment of the put -- proving the queued -> running transition happened
    // before the failure, behaviorally rather than by inspecting internals.
    let statusDuringPut: string | undefined;
    vi.spyOn(bucket, 'put').mockImplementation(async () => {
      statusDuringPut = (await exportJobRow(db, job.exportId)).status;
      throw new Error('simulated storage failure');
    });

    await processTallyExport(db, bucket, job.exportId);

    expect(statusDuringPut).toBe('running');
    const failed = await exportJobRow(db, job.exportId);
    expect(failed.status).toBe('failed');
    expect(failed.failure_reason).toContain('simulated storage failure');
    expect(failed.document_path).toBeNull();
    expect(failed.completed_at).toBeNull();
    expect(await bucket.get(`tally-exports/${job.exportId}.xml`)).toBeNull();
  });
});
