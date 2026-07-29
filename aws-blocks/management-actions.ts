import { sql, type Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from './migrations-runner';

// STR-014: deploy-time management actions, invoked directly via the AWS
// Lambda Invoke API (never through API Gateway/public HTTP) — only callers
// with IAM invoke permission (the CI deploy role) can reach these. Routed
// ahead of normal request handling in index.handler.ts.
export type ManagementActionName = 'migrate' | 'list-applied-migrations' | 'link-admin-account';

export function isManagementAction(event: unknown): event is { action: ManagementActionName } {
  const action = (event as { action?: unknown } | null)?.action;
  return action === 'migrate' || action === 'list-applied-migrations' || action === 'link-admin-account';
}

/**
 * STR-045: `link-admin-account` — binds a Cognito pool user to the member or
 * employee record they administer, which is what turns a pool sign-in into an
 * actor this API recognizes. This is the Provisioning Runbook §6.2 step
 * ("seed the initial management/EC accounts") and the only way an admin
 * account is ever created: the pool has self-sign-up off, and no public HTTP
 * route writes `cognito_sub`. Reachable solely through the IAM-gated Lambda
 * Invoke path this module already serves.
 */
export interface LinkAdminAccountEvent {
  action: 'link-admin-account';
  member_id?: string;
  employee_id?: string;
  cognito_sub?: string;
}

export class ManagementActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagementActionError';
  }
}

async function linkAdminAccount(event: LinkAdminAccountEvent, db: Database): Promise<unknown> {
  const { member_id: memberId, employee_id: employeeId, cognito_sub: cognitoSub } = event;
  if (!cognitoSub) throw new ManagementActionError('cognito_sub is required.');
  if (!memberId === !employeeId) {
    throw new ManagementActionError('Exactly one of member_id or employee_id is required.');
  }

  // Re-running provisioning for the same person is a no-op, not a second
  // account: an operator re-invoking the runbook step is expected.
  const updated = employeeId
    ? await db.queryOne<{ id: string }>(
        sql`UPDATE employees SET cognito_sub = ${cognitoSub} WHERE id = ${employeeId} RETURNING id`,
      )
    : await db.queryOne<{ id: string }>(
        sql`UPDATE members SET cognito_sub = ${cognitoSub} WHERE id = ${memberId} RETURNING id`,
      );
  if (!updated) throw new ManagementActionError(`No ${employeeId ? 'employee' : 'member'} ${employeeId ?? memberId}.`);

  return employeeId
    ? { linked: { employee_id: updated.id, cognito_sub: cognitoSub } }
    : { linked: { member_id: updated.id, cognito_sub: cognitoSub } };
}

// The Handler NodejsFunction's esbuild bundle only includes the JS
// dependency graph, not the migrations/*.sql assets — index.cdk.ts attaches
// them as a Lambda Layer (mounted at /opt) instead. AWS_LAMBDA_FUNCTION_NAME
// is set by the Lambda runtime itself in every real invocation (sandbox or
// production alike, not sandbox-specific), so this is the one place that
// needs to know which environment it's running in.
function resolveMigrationsDir(): string {
  return process.env.AWS_LAMBDA_FUNCTION_NAME ? '/opt' : MIGRATIONS_DIR;
}

export async function handleManagementAction(event: unknown, db: Database): Promise<unknown | undefined> {
  if (!isManagementAction(event)) return undefined;

  if (event.action === 'migrate') {
    return runLocalMigrations(db, resolveMigrationsDir());
  }

  if (event.action === 'link-admin-account') {
    return linkAdminAccount(event as LinkAdminAccountEvent, db);
  }

  // list-applied-migrations — queries through `db` (the same connection
  // runLocalMigrations uses) rather than a second, external connection
  // mechanism, so a caller outside the Lambda (T-I1's smoke test) never
  // needs to independently resolve cluster/secret ARNs or Blocks' own
  // config-registry indirection.
  const rows = await db.query<{ name: string }>(sql`SELECT name FROM _migrations ORDER BY id`);
  return { appliedVersions: rows.map(row => row.name) };
}
