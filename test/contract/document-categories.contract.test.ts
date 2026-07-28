import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-113 T-C1 (BE-C) — GET/PUT /v1/document-categories against the Admin
// OpenAPI, following the same real-handler dispatchRequest template as the
// STR-111/112 suites (test/contract/documents.contract.test.ts). Runs
// against the singleton `db` block, so these tests only ever ADD categories
// (unique-per-run names) — never remove seeded ones another suite's fixture
// may reference in the shared .bb-data store.

async function currentCategories(): Promise<string[]> {
  const response = await dispatchRequest('GET', '/v1/document-categories');
  return (response.body as { categories: string[] }).categories;
}

describe('STR-113 T-C1 — document-categories endpoint contract', () => {
  it('GET /v1/document-categories conforms to the declared 200 shape and includes the seeded categories', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const response = await dispatchRequest('GET', '/v1/document-categories');

    const op = await contractTest('admin', '/document-categories', 'get');
    expect(response.status).toBe(200);
    expect((response.body as { categories: string[] }).categories).toEqual(
      expect.arrayContaining(['Bye-laws', 'Circulars', 'KYC']),
    );
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('PUT /v1/document-categories with an added category conforms to the declared 200 shape and is visible on the next GET', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const added = `Fire Safety Audits ${randomUUID()}`;

    const response = await dispatchRequest('PUT', '/v1/document-categories', {
      categories: [...(await currentCategories()), added],
    });

    const op = await contractTest('admin', '/document-categories', 'put');
    expect(response.status).toBe(200);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
    expect(await currentCategories()).toContain(added);
  });

  it('PUT dropping a category still in use conforms to the declared 409 Error shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    // Pin 'Bye-laws' in use via the real registration handler (STR-111).
    const registerResponse = await dispatchRequest('POST', '/v1/documents', {
      level: 'society',
      title: 'Society Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      content_type: 'application/pdf',
    }, { 'X-Actor-Employee-Id': 'emp-1' });
    expect(registerResponse.status).toBe(201);

    const before = await currentCategories();
    const response = await dispatchRequest('PUT', '/v1/document-categories', {
      categories: before.filter(c => c !== 'Bye-laws'),
    });

    const op = await contractTest('admin', '/document-categories', 'put');
    expect(response.status).toBe(409);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
    expect(await currentCategories()).toEqual(before);
  });

  it('PUT with a non-array categories body conforms to the declared 422 response shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const before = await currentCategories();

    const response = await dispatchRequest('PUT', '/v1/document-categories', { categories: 'not-a-list' });

    const op = await contractTest('admin', '/document-categories', 'put');
    expect(response.status).toBe(422);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
    expect(await currentCategories()).toEqual(before);
  });
});
