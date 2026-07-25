import { matchRoute } from '@aws-blocks/blocks';
import type { BlocksContext } from '@aws-blocks/blocks';

// Dispatches a request against the RawRoute registry populated by importing
// aws-blocks/index.ts — the STR-003-decided routing mechanism, exercised
// in-process with no real HTTP server (same approach STR-003's spike proved
// out for the local Blocks runtime). Shared by every RawRoute endpoint's
// unit and contract tests; STR-005's health endpoint is the first consumer
// and the template for M1 endpoint stories.
//
// STR-025: the STR-003-noted body limitation is fixed here — an optional
// `body` parameter is sent through `request.json()` for POST/PUT/PATCH
// tests; GET-only callers are unaffected (defaults to `{}`, the prior
// always-empty behavior).

export interface DispatchResult {
  status: number;
  body: unknown;
}

export async function dispatchRequest(method: string, path: string, body: unknown = {}): Promise<DispatchResult> {
  const matched = matchRoute(method, path);
  if (!matched) {
    return { status: 404, body: undefined };
  }

  let sentBody: unknown;
  const context: BlocksContext = {
    request: {
      headers: new Headers(),
      body: null,
      json: async () => body,
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
