import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import {
  getLedgerAccountsForPeriod,
  getPostingsInPeriod,
  buildTallyExportXml,
} from '../../aws-blocks/finance/tally-export';
import { processTallyExport } from '../../aws-blocks/finance/tally-export-jobs';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff } from '../support/cognito-token';

// STR-103 T-C1..T-C4 (BE-C) — the Admin API Tally-export surface
// (startTallyExport 202/422, getExport 200/404, downloadExport 200/404/409)
// against the Admin OpenAPI, following the STR-111 real-handler
// dispatchRequest template on the singleton `db`/`documents` blocks.
//
// Determinism note: POSTing through the route submits to the real in-process
// mock queue, whose setTimeout-driven processing can't be awaited from a
// test. So the queued-state assertions use the POST response itself (written
// synchronously), and the completed-state cases seed the export_jobs row
// directly (never submitted to the queue) and invoke processTallyExport on
// the singleton blocks to force each transition deterministically.

/** Seeds an export_jobs row outside the queue, so no background processing
 * ever races the test's own processTallyExport call. */
async function seedQueuedExport(from: string, to: string): Promise<string> {
  const exportId = randomUUID();
  await db.execute(
    sql`INSERT INTO export_jobs (id, status, period_from, period_to)
        VALUES (${exportId}, 'queued', ${from}::date, ${to}::date)`,
  );
  return exportId;
}

describe('STR-103 T-C1 — POST /v1/exports/tally accepts a valid period', () => {
  it('returns 202 with a queued ExportJob conforming to the schema', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const response = await dispatchRequest('POST', '/v1/exports/tally', {
      from: '2031-05-01',
      to: '2031-05-31',
    }, await asAnyStaff(db));

    const op = await contractTest('admin', '/exports/tally', 'post');
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      export_id: expect.any(String),
      kind: 'tally',
      status: 'queued',
      from: '2031-05-01',
      to: '2031-05-31',
      requested_at: expect.any(String),
      completed_at: null,
      failure_reason: null,
    });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});

describe('STR-103 T-C2 — POST /v1/exports/tally rejects from after to', () => {
  it('returns 422 conforming to the schema, with no export_jobs row written', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const response = await dispatchRequest('POST', '/v1/exports/tally', {
      from: '2031-02-02',
      to: '2031-01-01',
    }, await asAnyStaff(db));

    const op = await contractTest('admin', '/exports/tally', 'post');
    expect(response.status).toBe(422);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();

    // Nothing written for the rejected request -- the period is distinctive
    // to this case, so any row here could only be the rejected one's.
    const rows = await db.query(sql`SELECT id FROM export_jobs WHERE period_from = ${'2031-02-02'}::date`);
    expect(rows).toHaveLength(0);
  });
});

describe('STR-103 T-C3 — GET /v1/exports/{exportId}', () => {
  it('returns 404 for an unknown id and a conforming ExportJob in the queued and completed states', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const op = await contractTest('admin', '/exports/{exportId}', 'get');

    const unknown = await dispatchRequest('GET', `/v1/exports/${randomUUID()}`, {}, await asAnyStaff(db));
    expect(unknown.status).toBe(404);
    expect(() => op.expectValidResponse(unknown.status, unknown.body)).not.toThrow();

    const exportId = await seedQueuedExport('2031-05-01', '2031-05-31');
    const queued = await dispatchRequest('GET', `/v1/exports/${exportId}`, {}, await asAnyStaff(db));
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({ export_id: exportId, status: 'queued' });
    expect(() => op.expectValidResponse(queued.status, queued.body)).not.toThrow();

    await processTallyExport(db, documents, exportId);
    const completed = await dispatchRequest('GET', `/v1/exports/${exportId}`, {}, await asAnyStaff(db));
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ export_id: exportId, status: 'completed' });
    expect(() => op.expectValidResponse(completed.status, completed.body)).not.toThrow();
  });

  // Review F4: the failed state is the one wire state where both nullable
  // fields flip -- failure_reason non-null, completed_at null -- and the
  // states above never serialize it.
  it('serializes a failed job conforming to the ExportJob schema', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const op = await contractTest('admin', '/exports/{exportId}', 'get');

    const exportId = randomUUID();
    await db.execute(
      sql`INSERT INTO export_jobs (id, status, period_from, period_to, failure_reason)
          VALUES (${exportId}, 'failed', ${'2031-05-01'}::date, ${'2031-05-31'}::date, ${'simulated generation failure'})`,
    );

    const response = await dispatchRequest('GET', `/v1/exports/${exportId}`, {}, await asAnyStaff(db));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      export_id: exportId,
      status: 'failed',
      failure_reason: 'simulated generation failure',
      completed_at: null,
    });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});

describe('STR-103 T-C4 — GET /v1/exports/{exportId}/download', () => {
  it('404s for an unknown id, 409s while not completed, then 200s with a presigned URL to the stored bytes', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const op = await contractTest('admin', '/exports/{exportId}/download', 'get');

    const unknown = await dispatchRequest('GET', `/v1/exports/${randomUUID()}/download`, {}, await asAnyStaff(db));
    expect(unknown.status).toBe(404);
    expect(() => op.expectValidResponse(unknown.status, unknown.body)).not.toThrow();

    const exportId = await seedQueuedExport('2031-05-01', '2031-05-31');
    const notCompleted = await dispatchRequest('GET', `/v1/exports/${exportId}/download`, {}, await asAnyStaff(db));
    expect(notCompleted.status).toBe(409);
    expect(() => op.expectValidResponse(notCompleted.status, notCompleted.body)).not.toThrow();

    // A posting inside the period makes the stored document non-trivial.
    await postJournalEntry(db, 'STR-103 contract fixture', [
      { accountId: 'bank', direction: 'debit', amount: '750.00' },
      { accountId: 'cash', direction: 'credit', amount: '750.00' },
    ], { postedAt: '2031-05-15T10:00:00Z' });
    await processTallyExport(db, documents, exportId);

    const ready = await dispatchRequest('GET', `/v1/exports/${exportId}/download`, {}, await asAnyStaff(db));
    expect(ready.status).toBe(200);
    expect(() => op.expectValidResponse(ready.status, ready.body)).not.toThrow();

    // AC4 -- byte-identity: in the local mock, bucket.get(document_path) is
    // the honest equivalent of following the presigned URL; the URL itself
    // must reference the stored document's path.
    const row = await db.queryOne<{ document_path: string }>(
      sql`SELECT document_path FROM export_jobs WHERE id = ${exportId}`,
    );
    const body = ready.body as { url: string; expires_at: string };
    expect(body.url).toEqual(expect.any(String));
    expect(body.url).toContain(row!.document_path);

    const expected = buildTallyExportXml(
      await getLedgerAccountsForPeriod(db, '2031-05-01', '2031-05-31'),
      await getPostingsInPeriod(db, '2031-05-01', '2031-05-31'),
    );
    const stored = await documents.get(row!.document_path);
    expect(stored!.body.toString('utf-8')).toBe(expected);
  });
});
