// STR-031 Refactor: shared request-validation and problem-response helpers,
// factored out of aws-blocks/members/members-routes.ts and aws-blocks/
// projects/projects-routes.ts for reuse by the rest of M1's Admin API
// stories. Builds the Admin/Mobile OpenAPI's Error schema shape
// (components/schemas/Error: `{ error: { code, message } }`, see
// aws-blocks/finance/books-routes.ts's inline version of the same shape)
// and maps a domain validation rejection to the matching 422 response.
import type { BlocksContext } from '@aws-blocks/blocks';

export interface ProblemResponse {
  error: { code: string; message: string };
}

/** Builds the Error schema's `{ error: { code, message } }` shape. */
export function problemResponse(code: string, message: string): ProblemResponse {
  return { error: { code, message } };
}

/**
 * Shared base for a module's domain-rejection error (e.g. members-api.ts's
 * MemberValidationError) -- writing nothing, thrown before any DB write, the
 * same convention finance/journal.ts's JournalError established. A route
 * handler catches this type and calls sendValidationError below rather than
 * inventing its own 422 mapping.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** 404 response for a resource that doesn't exist. */
export function sendNotFound(ctx: BlocksContext, message: string): void {
  ctx.response.status = 404;
  ctx.response.send(problemResponse('not_found', message));
}

/** 422 response for a rejected write -- the Error schema's `Invalid` case. */
export function sendValidationError(ctx: BlocksContext, error: ValidationError): void {
  ctx.response.status = 422;
  ctx.response.send(problemResponse('validation_error', error.message));
}

/**
 * Shared base for a module's domain-rejection error when an action is
 * invalid in the resource's current state (e.g. members-api.ts's
 * MemberLifecycleConflictError) -- writing nothing, thrown before any DB
 * write. A route handler catches this type and calls sendConflictError
 * below rather than inventing its own 409 mapping.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** 409 response for an action invalid in the resource's current state -- the Error schema's `Conflict` case. */
export function sendConflictError(ctx: BlocksContext, error: ConflictError): void {
  ctx.response.status = 409;
  ctx.response.send(problemResponse('conflict', error.message));
}
