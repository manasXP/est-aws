import { describe, it, expect } from 'vitest';
import '../../aws-blocks/index';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-005 T-C1 — the walking-skeleton endpoint's real handler response
// conforms to its OpenAPI definition, via the STR-002 contract-test harness.
// This is the first contract test to validate a real RawRoute handler's
// output (prior contract tests validated stub bodies) and is the template
// for M1 endpoint stories: dispatch the real handler, feed its response
// through the harness.

describe('STR-005 T-C1 — walking-skeleton health endpoint contract', () => {
  it("the real handler's response conforms to the mobile OpenAPI /health definition", async () => {
    const response = await dispatchRequest('GET', '/v1/health');

    const op = await contractTest('mobile', '/health', 'get');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});
