import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { documents } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-045 T-C1 -- the Admin OpenAPI declares `bearerAuth` globally
// (`security: [{bearerAuth: []}]`, no per-operation override anywhere), so
// every admin operation is a gated one. This sweeps every declared admin
// operation that is actually wired as a RawRoute today and asserts each
// answers 401 anonymously; an operation not yet built is skipped rather than
// silently passing. Genuine-gap ID: TC-MEM has no admin-authentication case.
//
// SPEC GAP (gate G7, recorded in the PR body): the Admin OpenAPI declares no
// `401` response on any operation and has no shared `Unauthorized` response
// component, so there is no *documented* problem shape to validate against.
// This asserts the repo's own Error-schema shape
// (aws-blocks/http/problem-response.ts) instead, and the assertion below on
// the missing declaration is what will fail -- deliberately, as a reminder --
// once EST-Spec adds it.

const ADMIN_BASE_PATH = '/v1';

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';
const VERBS: Verb[] = ['get', 'post', 'put', 'patch', 'delete'];

/** Every (verb, concrete path) the admin document declares, with templates
 * filled by throwaway ids -- an id that matches nothing is fine here, since
 * authentication is refused before any lookup runs. */
function declaredAdminOperations(): Array<{ verb: Verb; template: string; path: string }> {
  const paths = (documents.admin.paths ?? {}) as Record<string, Record<string, unknown>>;
  const operations: Array<{ verb: Verb; template: string; path: string }> = [];
  for (const [template, item] of Object.entries(paths)) {
    for (const verb of VERBS) {
      if (!item[verb]) continue;
      const path = ADMIN_BASE_PATH + template.replace(/\{[^}]+\}/g, () => randomUUID());
      operations.push({ verb, template, path });
    }
  }
  return operations;
}

describe('STR-045 T-C1 -- every wired admin operation is gated on a bearer token', () => {
  it('declares bearerAuth for the whole admin surface, with no operation opting out', () => {
    expect(documents.admin.security).toEqual([{ bearerAuth: [] }]);

    const paths = (documents.admin.paths ?? {}) as Record<string, Record<string, { security?: unknown }>>;
    const opted_out = Object.entries(paths).flatMap(([template, item]) =>
      VERBS.filter(verb => item[verb]?.security !== undefined).map(verb => `${verb.toUpperCase()} ${template}`),
    );
    expect(opted_out).toEqual([]);
  });

  it('answers 401 with the Error shape on every declared operation that is wired today', async () => {
    const wrongAnswers: string[] = [];
    let wired = 0;

    for (const { verb, template, path } of declaredAdminOperations()) {
      const response = await dispatchRequest(verb.toUpperCase(), path, {}, {});
      // 404 with no body is dispatchRequest's "no RawRoute matched" -- the
      // operation is declared but not built yet, so it is out of scope here.
      if (response.status === 404 && response.body === undefined) continue;
      wired++;
      if (response.status !== 401) {
        wrongAnswers.push(`${verb.toUpperCase()} ${template} -> ${response.status}`);
        continue;
      }
      const body = response.body as { error?: { code?: string } };
      if (body?.error?.code !== 'unauthorized') {
        wrongAnswers.push(`${verb.toUpperCase()} ${template} -> 401 with code ${String(body?.error?.code)}`);
      }
    }

    expect(wrongAnswers).toEqual([]);
    // Guards the sweep itself: a bug that matched nothing would otherwise
    // pass vacuously.
    expect(wired).toBeGreaterThan(20);
  });

  it('leaves the walking-skeleton health endpoint public', async () => {
    // The mobile document is where /health is declared, and it is the one
    // operation carrying an explicit `security: []` override.
    const health = (documents.mobile.paths?.['/health'] as { get?: { security?: unknown } } | undefined)?.get;
    expect(health?.security).toEqual([]);

    const response = await dispatchRequest('GET', '/v1/health', {}, {});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('records that the admin contract still declares no 401 response (gate G7)', () => {
    const paths = (documents.admin.paths ?? {}) as Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    const declaring401 = Object.entries(paths).flatMap(([template, item]) =>
      VERBS.filter(verb => item[verb]?.responses?.['401'] !== undefined).map(verb => `${verb.toUpperCase()} ${template}`),
    );

    // Inverted on purpose: the contract change is a human's to make (gate
    // G7). When EST-Spec adds the Unauthorized response, this fails and the
    // sweep above should switch to validating against the declared schema.
    expect(declaring401).toEqual([]);
  });
});
