// STR-042: the Admin API employee CRUD surface -- `GET`/`POST /v1/employees`,
// `GET`/`PATCH /v1/employees/{employeeId}`,
// `PUT /v1/employees/{employeeId}/capabilities`, and
// `POST /v1/employees/{employeeId}/salary-payments`, served through
// RawRoute (the STR-003-decided mechanism). Thin HTTP adapter: parses
// path/query/body/headers, then delegates to employees-api.ts for
// everything else. Mirrors members/members-routes.ts.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import {
  createEmployee,
  getEmployee,
  listEmployees,
  updateEmployee,
  setEmployeeCapabilities,
  recordSalaryPayment,
  EmployeeValidationError,
} from './employees-api';
import { getAssetViewGrants, setAssetViewGrants, AssetViewGrantValidationError } from './asset-view-grants-api';
import { JournalError } from '../finance/journal';
import { sendNotFound, sendValidationError, problemResponse, ValidationError } from '../http/problem-response';
import { requireAuthenticated, requireCapability } from '../http/capability-gate';

export function registerEmployeeRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-employees', {
    method: 'GET',
    path: '/v1/employees',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const items = await listEmployees(db);
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'create-employee', {
    method: 'POST',
    path: '/v1/employees',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

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
      if (!(await requireAuthenticated(ctx, db))) return;

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
      if (!(await requireAuthenticated(ctx, db))) return;

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
      if (!(await requireAuthenticated(ctx, db))) return;

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
      // 1. Capability gate (403) -- checked before anything else touches
      // the request. STR-044: real claims-derivation via the shared gate,
      // replacing this story's own original X-Capabilities stub.
      if (!(await requireCapability(ctx, db, 'finance-recorder'))) {
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

  // STR-057: per-project asset-view grants -- an audited admin action
  // (Asset Management spec), not gated on a governance capability of its
  // own (none is named for it, unlike finance-recorder above).
  new RawRoute(scope, 'get-asset-view-grants', {
    method: 'GET',
    path: '/v1/employees/{employeeId}/asset-view-grants',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const { employeeId } = ctx.request.params;
      const employee = await getEmployee(db, employeeId);
      if (!employee) {
        sendNotFound(ctx, `No employee ${employeeId}`);
        return;
      }
      const projectIds = await getAssetViewGrants(db, employeeId);
      ctx.response.send({ project_ids: projectIds });
    },
  });

  new RawRoute(scope, 'set-asset-view-grants', {
    method: 'PUT',
    path: '/v1/employees/{employeeId}/asset-view-grants',
    handler: async ctx => {
      const { employeeId } = ctx.request.params;
      const { project_ids } = await ctx.request.json();
      const actor = await requireAuthenticated(ctx, db);
      if (!actor) return;
      try {
        const projectIds = await setAssetViewGrants(db, employeeId, project_ids, actor);
        if (projectIds === null) {
          sendNotFound(ctx, `No employee ${employeeId}`);
          return;
        }
        ctx.response.send({ project_ids: projectIds });
      } catch (e) {
        if (e instanceof AssetViewGrantValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });
}
