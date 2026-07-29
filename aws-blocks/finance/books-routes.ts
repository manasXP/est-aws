// STR-024: the Admin API book-read surface — `GET /v1/books/{book}/entries`
// and `GET /v1/books/{book}/entries/{entryId}`, served through RawRoute
// (the STR-003-decided mechanism, see the /v1/health route in
// aws-blocks/index.ts). Thin HTTP adapter: parses path/query params, then
// delegates to books-api.ts for everything else.
//
// STR-026: joined by `POST /v1/books/{book}/entries/{entryId}/reversal`, the
// one write the Admin contract documents against a book entry. Same shape —
// the correction rules stay in STR-022's reversal.ts, this only reaches them.
import { RawRoute } from '@aws-blocks/blocks';
import { requireAuthenticated } from '../http/capability-gate';
import type { Database, Scope } from '@aws-blocks/blocks';
import { getBookEntry, isBookName, listBookEntries, type LedgerEntry } from './books-api';
import { reverseJournalEntry } from './reversal';
import { JournalError } from './journal';
import { requireCapability } from '../http/capability-gate';
import {
  ConflictError,
  sendConflictError,
  sendNotFound,
  sendValidationError,
  ValidationError,
} from '../http/problem-response';

function invalidBookResponse(book: string) {
  return { error: { code: 'invalid_book', message: `Unknown book: ${book}` } };
}

export function registerBookRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-book-entries', {
    method: 'GET',
    path: '/v1/books/{book}/entries',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

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
      if (!(await requireAuthenticated(ctx, db))) return;

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

  new RawRoute(scope, 'reverse-book-entry', {
    method: 'POST',
    path: '/v1/books/{book}/entries/{entryId}/reversal',
    handler: async ctx => {
      // 1. Capability gate (403) -- finance-recorder, the same capability
      // every other ledger-writing route gates on (invoice-payments-routes.ts).
      if (!(await requireCapability(ctx, db, 'finance-recorder'))) {
        return;
      }

      const book = ctx.request.params.book;
      if (!isBookName(book)) {
        ctx.response.status = 400;
        ctx.response.send(invalidBookResponse(book));
        return;
      }

      // 2. The two request fields the Admin contract marks required --
      // presence-only, the same convention as employees-routes.ts's
      // salary-payment endpoint and invoice-payments-routes.ts.
      if (!ctx.request.headers.get('Idempotency-Key')) {
        sendValidationError(ctx, new ValidationError('Idempotency-Key header is required.'));
        return;
      }
      const { reason } = await ctx.request.json();
      if (typeof reason !== 'string' || reason.trim() === '') {
        sendValidationError(ctx, new ValidationError('A reason is required to correct an entry.'));
        return;
      }

      const { entryId } = ctx.request.params;
      if (!(await getBookEntry(db, book, entryId))) {
        sendNotFound(ctx, `No entry ${entryId} in book ${book}`);
        return;
      }

      try {
        const { entryId: reversalEntryId } = await reverseJournalEntry(db, entryId, reason);
        // The reversal mirrors every line of the original -- same accounts,
        // same counterparties, only the directions flipped -- and book
        // membership keys on exactly those two things, so the new entry is
        // always projected into the same book the original was read from.
        const reversal = (await getBookEntry(db, book, reversalEntryId)) as LedgerEntry;
        ctx.response.status = 201;
        ctx.response.send(reversal);
      } catch (e) {
        // The existence check above already ruled out reverseJournalEntry's
        // other JournalError case (no such entry), leaving only "already
        // reversed" -- raised either by its own check or, under a concurrent
        // double correction, by migration 003's partial unique index.
        if (e instanceof JournalError) {
          sendConflictError(ctx, new ConflictError(e.message));
          return;
        }
        throw e;
      }
    },
  });
}
