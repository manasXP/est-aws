// STR-042: the Admin API employee CRUD surface -- `GET`/`POST /v1/employees`,
// `GET`/`PATCH /v1/employees/{employeeId}`,
// `PUT /v1/employees/{employeeId}/capabilities`, and
// `POST /v1/employees/{employeeId}/salary-payments`, served through
// RawRoute (the STR-003-decided mechanism). Thin HTTP adapter: parses
// path/query/body/headers, then delegates to employees-api.ts for
// everything else. Mirrors members/members-routes.ts.
import { RawRoute } from '@aws-blocks/blocks';
import type { BlocksContext, Database, Scope } from '@aws-blocks/blocks';
import {
  createEmployee,
  getEmployee,
  listEmployees,
  updateEmployee,
  setEmployeeCapabilities,
  recordSalaryPayment,
  EmployeeValidationError,
  type EmployeeCapability,
} from './employees-api';
import { JournalError } from '../finance/journal';
import { sendNotFound, sendValidationError, sendCapabilityRequired, problemResponse, ValidationError } from '../http/problem-response';

/**
 * STR-042: caller-declared capability stub for the salary-payments
 * capability gate. No auth/JWT system exists in this repo yet (E05/
 * STR-044 not built) -- per an explicit human decision already made for
 * this story, the caller declares their capabilities via the
 * `X-Capabilities` header (comma-separated capability names), standing in
 * for real JWT claims until STR-044 replaces this wholesale with real
 * claims-derivation.
 *
 * This is UNRELATED to an individual employee's `Employee.capabilities` DB
 * column: that field is about what a *specific employee's future real
 * account* would be granted once real auth exists. This header is a
 * generic "what does the *caller* of this request claim" stand-in, not
 * tied to any employee record in this story.
 */
function hasCapability(ctx: BlocksContext, capability: EmployeeCapability): boolean {
  const header = ctx.request.headers.get('X-Capabilities') ?? '';
  return header.split(',').map(c => c.trim()).includes(capability);
}

export function registerEmployeeRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-employees', {
    method: 'GET',
    path: '/v1/employees',
    handler: async ctx => {
      const items = await listEmployees(db);
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'create-employee', {
    method: 'POST',
    path: '/v1/employees',
    handler: async ctx => {
      const input = await ctx.request.json();
      try {
        const employee = await createEmployee(db, input);
        ctx.response.status = 201;
        ctx.response.send(employee);
      } catch (e) {
        if (e instanceof EmployeeValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'get-employee', {
    method: 'GET',
    path: '/v1/employees/{employeeId}',
    handler: async ctx => {
      const employee = await getEmployee(db, ctx.request.params.employeeId);
      if (!employee) {
        sendNotFound(ctx, `No employee ${ctx.request.params.employeeId}`);
        return;
      }
      ctx.response.send(employee);
    },
  });

  new RawRoute(scope, 'update-employee', {
    method: 'PATCH',
    path: '/v1/employees/{employeeId}',
    handler: async ctx => {
      const input = await ctx.request.json();
      try {
        const employee = await updateEmployee(db, ctx.request.params.employeeId, input);
        if (!employee) {
          sendNotFound(ctx, `No employee ${ctx.request.params.employeeId}`);
          return;
        }
        ctx.response.send(employee);
      } catch (e) {
        if (e instanceof EmployeeValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'set-employee-capabilities', {
    method: 'PUT',
    path: '/v1/employees/{employeeId}/capabilities',
    handler: async ctx => {
      const { capabilities } = await ctx.request.json();
      try {
        const employee = await setEmployeeCapabilities(db, ctx.request.params.employeeId, capabilities);
        if (!employee) {
          sendNotFound(ctx, `No employee ${ctx.request.params.employeeId}`);
          return;
        }
        ctx.response.send(employee);
      } catch (e) {
        if (e instanceof EmployeeValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'record-salary-payment', {
    method: 'POST',
    path: '/v1/employees/{employeeId}/salary-payments',
    handler: async ctx => {
      // 1. Capability gate (403, stub for STR-044) -- checked before
      // anything else touches the request.
      if (!hasCapability(ctx, 'finance-recorder')) {
        sendCapabilityRequired(ctx, 'finance-recorder');
        return;
      }

      // 2. Idempotency-Key presence check (422) -- presence-only, no
      // dedupe/replay logic; that's a bigger feature, explicitly out of
      // this story's minimal-Green scope.
      const idempotencyKey = ctx.request.headers.get('Idempotency-Key');
      if (!idempotencyKey) {
        sendValidationError(ctx, new ValidationError('Idempotency-Key header is required.'));
        return;
      }

      const input = await ctx.request.json();
      try {
        const entry = await recordSalaryPayment(db, ctx.request.params.employeeId, input);
        if (!entry) {
          sendNotFound(ctx, `No employee ${ctx.request.params.employeeId}`);
          return;
        }
        ctx.response.status = 201;
        ctx.response.send(entry);
      } catch (e) {
        if (e instanceof EmployeeValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        if (e instanceof JournalError) {
          ctx.response.status = 422;
          ctx.response.send(problemResponse('validation_error', e.message));
          return;
        }
        throw e;
      }
    },
  });
}
