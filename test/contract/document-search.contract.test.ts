import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-115 T-C1 (BE-C) — GET /v1/documents against the Admin OpenAPI's
// Page-wrapped Document[] response, plus the PATCH member_visible flip the
// same story makes writable. Follows the real-handler dispatchRequest
// template of the STR-111..114 suites. Runs against the singleton `db`, so
// every fixture uses a unique search token (uuid-derived) — results are
// asserted by membership, never by exact count, to stay immune to
// .bb-data accumulation across runs.

function uniqueToken(): string {
  return `zq${randomUUID().replaceAll('-', '')}`;
}

async function registerWithTitle(title: string): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/documents', {
    level: 'society',
    title,
    category: 'Correspondence',
    filename: 'fixture.pdf',
    content_type: 'application/pdf',
  }, { 'X-Actor-Employee-Id': 'emp-1' });
  expect(response.status).toBe(201);
  return (response.body as { document_id: string }).document_id;
}

describe('STR-115 T-C1 — document search endpoint contract', () => {
  it('GET /v1/documents conforms to the declared Page-wrapped Document[] shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const token = uniqueToken();
    const documentId = await registerWithTitle(`Fixture ${token}`);

    const response = await dispatchRequest('GET', `/v1/documents?q=${token}`);

    const op = await contractTest('admin', '/documents', 'get');
    expect(response.status).toBe(200);
    const body = response.body as { items: { document_id: string }[]; next_cursor: string | null };
    expect(body.items.map(d => d.document_id)).toEqual([documentId]);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('GET /v1/documents defaults to status=active, excluding archived documents like STR-114 listing', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const token = uniqueToken();
    const activeId = await registerWithTitle(`Live ${token}`);
    const archivedId = await registerWithTitle(`Gone ${token}`);
    await dispatchRequest('POST', `/v1/documents/${archivedId}/archive`);

    const defaulted = await dispatchRequest('GET', `/v1/documents?q=${token}`);
    const all = await dispatchRequest('GET', `/v1/documents?q=${token}&status=all`);

    const op = await contractTest('admin', '/documents', 'get');
    expect(defaulted.status).toBe(200);
    expect((defaulted.body as { items: { document_id: string }[] }).items.map(d => d.document_id)).toEqual([activeId]);
    const allIds = (all.body as { items: { document_id: string }[] }).items.map(d => d.document_id);
    expect(allIds).toContain(activeId);
    expect(allIds).toContain(archivedId);
    expect(() => op.expectValidResponse(defaulted.status, defaulted.body)).not.toThrow();
    expect(() => op.expectValidResponse(all.status, all.body)).not.toThrow();
  });

  it('PATCH /v1/documents/{documentId} with member_visible conforms to the Document shape and flips the flag', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registerWithTitle(`Visibility ${uniqueToken()}`);

    const response = await dispatchRequest('PATCH', `/v1/documents/${documentId}`, {
      member_visible: true,
    }, { 'X-Actor-Employee-Id': 'emp-1' });

    const op = await contractTest('admin', '/documents/{documentId}', 'patch');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ document_id: documentId, member_visible: true });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});
