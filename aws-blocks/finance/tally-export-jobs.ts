// STR-103: E11's assembly story -- the export_jobs lifecycle behind
// POST /v1/exports/tally. AsyncJob is fire-and-forget with no built-in
// status API, so per its own documented pattern ("Track job status in your
// handler") the handler updates an export_jobs row at each transition
// (`queued -> running -> completed | failed`), one db.transaction per state
// change -- the STR-079 precedent of trusting the table, not the queue, to
// carry status. Generation itself is purely STR-101's masters + STR-102's
// vouchers (aws-blocks/finance/tally-export.ts), concatenated verbatim --
// this module assembles, it never builds XML of its own.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, FileBucket } from '@aws-blocks/blocks';
import { ValidationError } from '../http/problem-response';
import {
  getLedgerAccountsForPeriod,
  buildLedgerMastersXml,
  getPostingsInPeriod,
  buildDayBookVouchersXml,
} from './tally-export';

export type ExportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

/** One export_jobs row, camel-cased -- the OpenAPI ExportJob shape plus the
 * internal documentPath (which the wire shape never carries). */
export interface ExportJobRecord {
  exportId: string;
  kind: string;
  status: ExportJobStatus;
  from: string;
  to: string;
  requestedAt: string;
  completedAt: string | null;
  failureReason: string | null;
  documentPath: string | null;
}

/** The one AsyncJob capability startTallyExport needs -- structural (rather
 * than the concrete AsyncJob class) so unit tests can capture the submitted
 * payload with a stub instead of driving the real in-process queue. */
export interface ExportJobQueue {
  submit(payload: { exportId: string }): Promise<{ jobId: string }>;
}

/** Between the masters and vouchers documents in the stored file. Exported
 * so tests can assert byte-identity against the generators' own output. */
export const TALLY_EXPORT_XML_SEPARATOR = '\n';

// Presigned download lifetime -- no contract-specified value, same
// sane-short-lived-window reasoning as documents-api.ts's
// DOWNLOAD_URL_EXPIRES_IN_SECONDS.
export const EXPORT_DOWNLOAD_URL_EXPIRES_IN_SECONDS = 600;

interface ExportJobRow {
  id: string;
  kind: string;
  status: ExportJobStatus;
  period_from: string;
  period_to: string;
  requested_at: string | Date;
  completed_at: string | Date | null;
  failure_reason: string | null;
  document_path: string | null;
}

/** Normalizes Postgres' text rendering (or PGlite's Date objects) to the
 * RFC 3339 the ExportJob schema's `format: date-time` requires -- the same
 * boundary normalization the offline-payment route applies to issued_at. */
function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}

function toRecord(row: ExportJobRow): ExportJobRecord {
  return {
    exportId: row.id,
    kind: row.kind,
    status: row.status,
    from: row.period_from,
    to: row.period_to,
    requestedAt: toIso(row.requested_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    failureReason: row.failure_reason,
    documentPath: row.document_path,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `POST /v1/exports/tally` business logic (AC1): validates the period
 * (both bounds present, YYYY-MM-DD-shaped, `from <= to` -- string comparison
 * is a correct date comparison for ISO dates), inserts the `queued` row,
 * submits the AsyncJob payload, and returns the ExportJob record. Nothing is
 * written on rejection.
 */
export async function startTallyExport(
  db: Database,
  queue: ExportJobQueue,
  from: string,
  to: string,
): Promise<ExportJobRecord> {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new ValidationError('from and to are required YYYY-MM-DD dates.');
  }
  if (from > to) {
    throw new ValidationError('from must not be after to.');
  }

  const exportId = randomUUID();
  await db.execute(
    sql`INSERT INTO export_jobs (id, status, period_from, period_to)
        VALUES (${exportId}, 'queued', ${from}::date, ${to}::date)`,
  );
  await queue.submit({ exportId });
  return (await getExportJob(db, exportId))!;
}

/** `GET /v1/exports/{exportId}` business logic -- record or null (the route 404s). */
export async function getExportJob(db: Database, exportId: string): Promise<ExportJobRecord | null> {
  const row = await db.queryOne<ExportJobRow>(
    sql`SELECT id, kind, status, period_from::text AS period_from, period_to::text AS period_to,
               requested_at, completed_at, failure_reason, document_path
        FROM export_jobs WHERE id = ${exportId}`,
  );
  return row ? toRecord(row) : null;
}

/**
 * The AsyncJob handler body (AC2, TC-FIN-042): marks the row `running`,
 * generates STR-101's masters + STR-102's vouchers for the row's own period,
 * stores the concatenated document at `tally-exports/<exportId>.xml`, and
 * marks `completed` + document_path + completed_at. Each status write is its
 * own db.transaction (the STR-079 one-transaction-per-state-change
 * precedent). Any thrown error is caught and written as `failed` +
 * failure_reason -- and deliberately NOT rethrown: the export_jobs row is
 * the status of record, and rethrowing would make the queue retry (and
 * eventually DLQ) a job the table already marked failed.
 */
export async function processTallyExport(db: Database, bucket: FileBucket, exportId: string): Promise<void> {
  const job = await getExportJob(db, exportId);
  if (!job) return; // no row to carry a failure -- nothing to process either

  await db.transaction(async tx => {
    await tx.execute(sql`UPDATE export_jobs SET status = 'running' WHERE id = ${exportId}`);
  });

  try {
    const masters = buildLedgerMastersXml(await getLedgerAccountsForPeriod(db, job.from, job.to));
    const vouchers = buildDayBookVouchersXml(await getPostingsInPeriod(db, job.from, job.to));
    const documentPath = `tally-exports/${exportId}.xml`;
    await bucket.put(documentPath, masters + TALLY_EXPORT_XML_SEPARATOR + vouchers, {
      contentType: 'application/xml',
    });
    await db.transaction(async tx => {
      await tx.execute(
        sql`UPDATE export_jobs SET status = 'completed', document_path = ${documentPath}, completed_at = now()
            WHERE id = ${exportId}`,
      );
    });
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    await db.transaction(async tx => {
      await tx.execute(sql`UPDATE export_jobs SET status = 'failed', failure_reason = ${reason} WHERE id = ${exportId}`);
    });
  }
}

/** `GET /v1/exports/{exportId}/download` outcomes -- documents-api.ts's
 * null-collapsing getDownloadUrl can't distinguish the contract's 404
 * (unknown id) from its 409 (not yet completed), so a discriminated result. */
export type ExportDownload =
  | { outcome: 'not_found' }
  | { outcome: 'not_completed' }
  | { outcome: 'ready'; url: string; expiresAt: string };

export async function getExportDownloadUrl(
  db: Database,
  bucket: FileBucket,
  exportId: string,
): Promise<ExportDownload> {
  const job = await getExportJob(db, exportId);
  if (!job) return { outcome: 'not_found' };
  if (job.status !== 'completed' || job.documentPath === null) return { outcome: 'not_completed' };

  const url = await bucket.getUrl(job.documentPath, { expiresIn: EXPORT_DOWNLOAD_URL_EXPIRES_IN_SECONDS });
  const expiresAt = new Date(Date.now() + EXPORT_DOWNLOAD_URL_EXPIRES_IN_SECONDS * 1000).toISOString();
  return { outcome: 'ready', url, expiresAt };
}
