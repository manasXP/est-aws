// STR-024: the Admin API book-read surface — `GET /v1/books/{book}/entries`
// and `GET /v1/books/{book}/entries/{entryId}`, served through RawRoute
// (the STR-003-decided mechanism, see the /v1/health route in
// aws-blocks/index.ts). Thin HTTP adapter: parses path/query params, then
// delegates to books-api.ts for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import { getBookEntry, isBookName, listBookEntries } from './books-api';

function invalidBookResponse(book: string) {
  return { error: { code: 'invalid_book', message: `Unknown book: ${book}` } };
}

export function registerBookRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-book-entries', {
    method: 'GET',
    path: '/v1/books/{book}/entries',
    handler: async ctx => {
      const book = ctx.request.params.book;
      if (!isBookName(book)) {
        ctx.response.status = 400;
        ctx.response.send(invalidBookResponse(book));
        return;
      }

      const from = ctx.request.url.searchParams.get('from') ?? undefined;
      const to = ctx.request.url.searchParams.get('to') ?? undefined;
      const items = await listBookEntries(db, book, { from, to });
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'get-book-entry', {
    method: 'GET',
    path: '/v1/books/{book}/entries/{entryId}',
    handler: async ctx => {
      const book = ctx.request.params.book;
      if (!isBookName(book)) {
        ctx.response.status = 400;
        ctx.response.send(invalidBookResponse(book));
        return;
      }

      const entry = await getBookEntry(db, book, ctx.request.params.entryId);
      if (!entry) {
        ctx.response.status = 404;
        ctx.response.send({ error: { code: 'not_found', message: `No entry ${ctx.request.params.entryId} in book ${book}` } });
        return;
      }
      ctx.response.send(entry);
    },
  });
}
