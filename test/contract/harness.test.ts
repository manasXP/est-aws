import { describe, it, expect } from 'vitest';
import { contractTest, documents, validateDocument } from './harness';

// STR-002: contract-test harness (BE-C) against the Admin and Mobile OpenAPI
// documents in est-spec/okf-bundle/api/. The two documents are the single
// source of truth — read directly from the est-spec submodule, no vendored
// copy to keep in sync.

describe('STR-002 contract-test harness', () => {
  // T-C1
  it('loads and validates both OpenAPI documents; rejects a corrupted one', async () => {
    // Importing this module already validated both real documents via
    // top-level await — this asserts that succeeded and is usable.
    expect(documents.admin.paths).toBeDefined();
    expect(documents.mobile.paths).toBeDefined();

    // Same function the harness uses on the real documents, given a
    // deliberately corrupted one (missing required info.version).
    const corrupted = { openapi: '3.1.0', info: { title: 'Corrupted' }, paths: {} };
    await expect(validateDocument(corrupted)).rejects.toThrow();
  });

  // T-C2 — covers AC2 (nonconforming half)
  it('fails a stub response missing a required field declared by the document', async () => {
    const op = await contractTest('mobile', '/me', 'get');
    const nonconforming = {
      member_id: 'm1',
      // `name` is required by the Member schema and is missing here
      member_status: 'active',
      joining_date: '2020-01-01'
    };
    expect(() => op.expectValidResponse(200, nonconforming)).toThrow();
  });

  it('fails a stub response with a status code not declared for the operation', async () => {
    const op = await contractTest('mobile', '/me', 'get');
    expect(() => op.expectValidResponse(500, { error: { code: 'x', message: 'x' } })).toThrow(/no 500 response declared/);
  });

  // T-C3 — covers AC2 (conforming half)
  it('passes a stub response that conforms to the declared schema', async () => {
    const op = await contractTest('mobile', '/me', 'get');
    const conforming = {
      member_id: 'm1',
      name: 'Asha Rao',
      member_status: 'active',
      joining_date: '2020-01-01'
    };
    expect(() => op.expectValidResponse(200, conforming)).not.toThrow();
  });

  // T-C4 — covers AC3
  it('reports an undeclared path/verb as a contract violation rather than ignoring it', async () => {
    await expect(contractTest('mobile', '/not-in-the-contract', 'get')).rejects.toThrow(
      /not declared/
    );
  });

  it('matches a concrete request path against a declared OpenAPI path template', async () => {
    // admin/openapi.yaml declares GET /members/{memberId}; a real request path
    // must resolve against the template, not fail as an undeclared route.
    await expect(contractTest('admin', '/members/m-123', 'get')).resolves.toBeDefined();
  });
});
