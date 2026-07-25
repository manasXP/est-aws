import { matchRoute } from '@aws-blocks/blocks';
import type { BlocksContext } from '@aws-blocks/blocks';

// Dispatches a request against the RawRoute registry populated by importing
// aws-blocks/index.ts — the STR-003-decided routing mechanism, exercised
// in-process with no real HTTP server (same approach STR-003's spike proved
// out for the local Blocks runtime). Shared by every RawRoute endpoint's
// unit and contract tests; STR-005's health endpoint is the first consumer
// and the template for M1 endpoint stories.
//
// Limitation carried over from the STR-003 spike: always sends an empty
// body — fine for GET routes, but a POST/webhook test needs a body
// parameter added here first, not a silent {} substitute.

export interface DispatchResult {
  status: number;
  body: unknown;
}

export async function dispatchRequest(method: string, path: string): Promise<DispatchResult> {
  // matchRoute's compiled patterns are anchored to the path only (no query
  // string handling) — strip it before matching, but keep it in the URL
  // passed to the handler below so req.url.searchParams works.
  const matched = matchRoute(method, path.split('?')[0]);
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
