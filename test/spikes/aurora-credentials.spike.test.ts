import { describe, it, expect } from 'vitest';
import { db } from '../../aws-blocks/index';
import { checkDatabaseConnection } from './aurora-credentials-helper';

// STR-004 Q2: by what mechanism does the Database Block expose Aurora
// credentials to (a) the Lambda runtime and (b) a deploy-time invocation, and
// what is the local equivalent?
// T-I1 (local half): a connection check succeeds using only the mechanism
// Blocks provides — the real `db` export from the IFC layer, not a spike
// stand-in — with zero AWS credentials present (test/setup.ts strips them).
// The sandbox half (repeating this against a real ap-south-1 Aurora cluster)
// is deferred: this environment has no AWS account (gate G5, spend/bill, not
// yet cleared).
//
// Kept as a permanent smoke check, not deleted with the spike scope (see the
// story's Refactor note): STR-011/STR-014 need exactly this proof against the
// real cluster once AWS access exists.
describe('STR-004 Q2 — Aurora credential mechanism (local half)', () => {
  it('connects through the Database Block\'s own query API with no AWS credentials', async () => {
    const result = await checkDatabaseConnection(db);
    expect(result.ok).toBe(true);
  });
});
