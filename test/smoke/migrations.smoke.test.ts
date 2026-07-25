import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { MIGRATIONS_DIR, SQL_FILE } from '../../aws-blocks/migrations-runner';
import { readDeployedStackOutputs, invokeManagementAction } from './support/deployed-stack';

// STR-014 T-I1 — after the deploy-time migration Lambda invocation, the
// deployed Aurora's _migrations tracking table (STR-011's finding: Blocks'
// native migration engine self-creates `_migrations`, not the spec's
// `schema_migrations`) exactly matches the repo's migration file set — no
// missing, no extra. Reads applied state via the same deployed Lambda
// (list-applied-migrations, queried through `db` there) rather than a
// second, external connection to Aurora — see management-actions.ts.

describe('STR-014 T-I1 — deployed migration state matches the repo exactly', () => {
  it('applied migrations on sandbox Aurora equal the repo\'s migration file set', async () => {
    const { handlerFunctionName } = readDeployedStackOutputs();

    const result = await invokeManagementAction(handlerFunctionName, 'list-applied-migrations');
    const applied = (result as { appliedVersions: string[] }).appliedVersions;

    const expected = readdirSync(MIGRATIONS_DIR).filter(file => SQL_FILE.test(file)).sort();

    expect(applied.sort()).toEqual(expected);
  });
});
