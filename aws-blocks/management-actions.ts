import { sql, type Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from './migrations-runner';

// STR-014: deploy-time management actions, invoked directly via the AWS
// Lambda Invoke API (never through API Gateway/public HTTP) — only callers
// with IAM invoke permission (the CI deploy role) can reach these. Routed
// ahead of normal request handling in index.handler.ts.
export type ManagementActionName = 'migrate' | 'list-applied-migrations';

export function isManagementAction(event: unknown): event is { action: ManagementActionName } {
  const action = (event as { action?: unknown } | null)?.action;
  return action === 'migrate' || action === 'list-applied-migrations';
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

  // list-applied-migrations — queries through `db` (the same connection
  // runLocalMigrations uses) rather than a second, external connection
  // mechanism, so a caller outside the Lambda (T-I1's smoke test) never
  // needs to independently resolve cluster/secret ARNs or Blocks' own
  // config-registry indirection.
  const rows = await db.query<{ name: string }>(sql`SELECT name FROM _migrations ORDER BY id`);
  return { appliedVersions: rows.map(row => row.name) };
}
