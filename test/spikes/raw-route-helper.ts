import { RawRoute, Scope, clearRouteRegistry } from '@aws-blocks/blocks';

// STR-003 Q1 spike — proves Blocks serves plain HTTP routes natively via
// RawRoute, with no CDK escape hatch (API Gateway + Lambda) needed. This
// dispatches directly against the in-process route registry rather than a
// real TCP server, matching how STR-001 tests Blocks' other local
// implementations (no AWS, no separate process). Kept (not deleted like the
// Q2 spike) as groundwork for STR-005's walking-skeleton endpoint, which
// will be the first real RawRoute handler in aws-blocks/index.ts.
//
// dispatchRequest/DispatchResult now live in ../support/dispatch (STR-005) —
// re-exported here so existing imports of this module keep working.
export { dispatchRequest, type DispatchResult } from '../support/dispatch';

const spikeScope = new Scope('str-003-spike');

export function registerSpikeRoute(): void {
  clearRouteRegistry();

  new RawRoute(spikeScope, 'health', {
    method: 'GET',
    path: '/str-003-spike/health',
    handler: async (ctx) => {
      ctx.response.send({ status: 'ok' });
    }
  });

  new RawRoute(spikeScope, 'echo', {
    method: 'GET',
    path: '/str-003-spike/echo/{id}',
    handler: async (ctx) => {
      ctx.response.send({ id: ctx.request.params.id });
    }
  });
}
