// STR-057: per-project asset-view grants for employees, sitting between the
// `asset_view_grants`/`asset_view_grant_audits` tables
// (migrations/016_asset_view_grants.sql) and the HTTP layer
// (aws-blocks/employees/employees-routes.ts) -- kept separate so it's
// testable with a plain Database, no HTTP dispatch required (test/employees/
// asset-view-grants-api.test.ts). Mirrors the employees-api.ts /
// employees-routes.ts split.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { ValidationError } from '../http/problem-response';
import { getEmployee } from './employees-api';
import { getProject } from '../projects/projects-api';
import type { Actor } from '../members/capabilities';

/** Domain rejection for a grant write -- nothing is written when this is thrown. */
export class AssetViewGrantValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'AssetViewGrantValidationError';
  }
}

/** `GET /employees/{employeeId}/asset-view-grants` -- the employee's
 * currently granted project ids, empty by default. Does not itself check
 * the employee exists -- the route layer does that for the 404 mapping. */
export async function getAssetViewGrants(db: Database, employeeId: string): Promise<string[]> {
  const rows = await db.query<{ project_id: string }>(
    sql`SELECT project_id FROM asset_view_grants WHERE employee_id = ${employeeId} ORDER BY project_id`,
  );
  return rows.map(row => row.project_id);
}

/**
 * `PUT /employees/{employeeId}/asset-view-grants` -- replaces the employee's
 * granted project ids (Asset Management spec: "an audited admin action").
 * Rejects -- writing nothing -- if the employee has no admin account (no
 * capabilities designated, employees-api.ts's `capabilities: []` default)
 * or if any project id is unknown. Every call that reaches the employee/
 * project checks writes an audit row (actor, timestamp, before/after),
 * whether or not the set actually changed (AC4: "every grant/revoke is
 * audited"). Returns `null` if the employee doesn't exist.
 */
export async function setAssetViewGrants(
  db: Database,
  employeeId: string,
  projectIds: unknown,
  actor: Actor | null,
): Promise<string[] | null> {
  const employee = await getEmployee(db, employeeId);
  if (!employee) return null;

  if (!Array.isArray(projectIds) || !projectIds.every(p => typeof p === 'string')) {
    throw new AssetViewGrantValidationError('project_ids must be an array of strings.');
  }
  if (employee.capabilities.length === 0) {
    throw new AssetViewGrantValidationError(`Employee ${employeeId} has no admin account -- asset-view grants require one.`);
  }
  for (const projectId of projectIds) {
    if (!(await getProject(db, projectId))) {
      throw new AssetViewGrantValidationError(`No project ${projectId}.`);
    }
  }

  const before = await getAssetViewGrants(db, employeeId);
  const actorMemberId = actor && 'memberId' in actor ? actor.memberId : null;
  const actorEmployeeId = actor && 'employeeId' in actor ? actor.employeeId : null;

  await db.transaction(async tx => {
    await tx.execute(sql`DELETE FROM asset_view_grants WHERE employee_id = ${employeeId}`);
    for (const projectId of projectIds) {
      await tx.execute(sql`INSERT INTO asset_view_grants (employee_id, project_id) VALUES (${employeeId}, ${projectId})`);
    }
    await tx.execute(
      sql`INSERT INTO asset_view_grant_audits (id, employee_id, actor_member_id, actor_employee_id, before_project_ids, after_project_ids)
          VALUES (${randomUUID()}, ${employeeId}, ${actorMemberId}, ${actorEmployeeId}, ${JSON.stringify(before)}, ${JSON.stringify(projectIds)})`,
    );
  });

  return projectIds;
}
