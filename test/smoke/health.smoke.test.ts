import { describe, it, expect } from 'vitest';
import { contractTest } from '../contract/harness';
import { readDeployedStackOutputs } from './support/deployed-stack';

// STR-014 T-E1 — after a real CI deploy, the walking-skeleton endpoint on the
// deployed sandbox stack responds and conforms to its OpenAPI definition.
// Reuses STR-002's contract-test harness (schema validation is dispatch-
// mechanism-agnostic) against a real fetch instead of the in-process
// dispatcher STR-005's health.contract.test.ts uses locally.

describe('STR-014 T-E1 — walking-skeleton health endpoint against the deployed sandbox', () => {
  it('responds and conforms to the mobile OpenAPI /health definition', async () => {
    const { gatewayUrl } = readDeployedStackOutputs();

    const response = await fetch(new URL('v1/health', gatewayUrl));
    const body = await response.json();

    const op = await contractTest('mobile', '/health', 'get');
    expect(() => op.expectValidResponse(response.status, body)).not.toThrow();
  });
});
