import { RawRoute, Scope, matchRoute, clearRouteRegistry } from '@aws-blocks/blocks';
import type { BlocksContext } from '@aws-blocks/blocks';

// STR-003 Q1 spike — proves Blocks serves plain HTTP routes natively via
// RawRoute, with no CDK escape hatch (API Gateway + Lambda) needed. This
// dispatches directly against the in-process route registry rather than a
// real TCP server, matching how STR-001 tests Blocks' other local
// implementations (no AWS, no separate process). Kept (not deleted like the
// Q2 spike) as groundwork for STR-005's walking-skeleton endpoint, which
// will be the first real RawRoute handler in aws-blocks/index.ts.
//
// Limitation: dispatchRequest() always sends an empty body (no request.body/
// json()/text() wiring) — fine for the GET routes proven here, but a future
// POST/webhook test built on this helper needs a body parameter added first,
// not a silent {} substitute.

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

export interface DispatchResult {
  status: number;
  body: unknown;
}

export async function dispatchRequest(method: string, path: string): Promise<DispatchResult> {
  const matched = matchRoute(method, path);
  if (!matched) {
    return { status: 404, body: undefined };
  }

  let sentBody: unknown;
  const context: BlocksContext = {
    request: {
      headers: new Headers(),
      body: null,
      json: async () => ({}),
      text: async () => '',
      url: new URL(`http://localhost${path}`),
      params: matched.params
    },
    response: {
      headers: new Headers(),
      status: 200,
      send: (body: unknown) => {
        sentBody = body;
      }
    }
  };

  await matched.route.handler(context);
  return { status: context.response.status, body: sentBody };
}
