import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../aws-blocks/index';
import { checkDatabaseConnection } from './aurora-credentials-helper';

// STR-004 Q2: by what mechanism does the Database Block expose Aurora
// credentials to (a) the Lambda runtime and (b) a deploy-time invocation, and
// what is the local equivalent?
// T-I1 (local half): a connection check succeeds using only the mechanism
// Blocks provides — the real `db` export from the IFC layer, not a spike
// stand-in — with zero AWS credentials present. The sandbox half (repeating
// this against a real ap-south-1 Aurora cluster) is deferred: this machine
// has no AWS account (gate G5, spend/bill, not yet cleared).
beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWS_')) delete process.env[key];
  }
});

describe('STR-004 Q2 — Aurora credential mechanism (local half)', () => {
  it('connects through the Database Block\'s own query API with no AWS credentials', async () => {
    const result = await checkDatabaseConnection(db);
    expect(result.ok).toBe(true);
  });

  it('never reads a hand-plumbed credential env var — only the Block instance is used', () => {
    expect(checkDatabaseConnection.toString()).not.toMatch(/process\.env\.(DATABASE_URL|PG(HOST|USER|PASSWORD|PORT)|CLUSTER_ARN|SECRET_ARN)/);
  });
});
