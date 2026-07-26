import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { createMember } from '../../aws-blocks/members/members-api';
import {
  getAssetViewGrants,
  setAssetViewGrants,
  AssetViewGrantValidationError,
} from '../../aws-blocks/employees/asset-view-grants-api';

// STR-057 — Employee asset-view grant business logic, unit cases. Follows
// the STR-042 test pattern (test/employees/employees-api.test.ts): fresh
// Database + Scope per test, baseline + domain migrations applied via
// MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-057-grants-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

async function adminEmployee(db: Database): Promise<string> {
  const employee = await createEmployee(db, { name: 'Grant Target' });
  await setEmployeeCapabilities(db, employee.employee_id, ['data-entry']);
  return employee.employee_id;
}

// T-U3: covers TC-AST-044 -- granting or revoking via
// PUT /v1/employees/{employeeId}/asset-view-grants records an audit entry
// (actor, timestamp, before/after); revocation takes effect on the next
// read.
describe('STR-057 T-U3 — asset-view grant/revoke is audited', () => {
  it('granting records an audit entry with actor, timestamp, and before/after', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Audited Project' });
    const employeeId = await adminEmployee(db);
    const actorMember = await createMember(db, { name: 'Granting Admin' });

    const result = await setAssetViewGrants(db, employeeId, [project.project_id], { memberId: actorMember.member_id });
    expect(result).toEqual([project.project_id]);

    const audits = await db.query<{
      employee_id: string;
      actor_member_id: string | null;
      actor_employee_id: string | null;
      before_project_ids: string;
      after_project_ids: string;
      created_at: string | Date;
    }>(sql`SELECT * FROM asset_view_grant_audits WHERE employee_id = ${employeeId}`);

    expect(audits).toHaveLength(1);
    expect(audits[0].actor_member_id).toBe(actorMember.member_id);
    expect(audits[0].actor_employee_id).toBeNull();
    expect(JSON.parse(audits[0].before_project_ids)).toEqual([]);
    expect(JSON.parse(audits[0].after_project_ids)).toEqual([project.project_id]);
    expect(audits[0].created_at).toBeTruthy();
  });

  it('revoking (an empty PUT) records the prior grant as before, and takes effect on the next read', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Revoked Project' });
    const employeeId = await adminEmployee(db);
    await setAssetViewGrants(db, employeeId, [project.project_id], null);

    await setAssetViewGrants(db, employeeId, [], null);

    const audits = await db.query<{ before_project_ids: string; after_project_ids: string }>(
      sql`SELECT * FROM asset_view_grant_audits WHERE employee_id = ${employeeId} ORDER BY created_at`,
    );
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1].before_project_ids)).toEqual([project.project_id]);
    expect(JSON.parse(audits[1].after_project_ids)).toEqual([]);

    expect(await getAssetViewGrants(db, employeeId)).toEqual([]);
  });

  it('rejects a grant for an employee with no admin account (no capabilities): 422, writing nothing', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'No Account Project' });
    const employee = await createEmployee(db, { name: 'Undesignated Employee' });

    await expect(setAssetViewGrants(db, employee.employee_id, [project.project_id], null)).rejects.toThrow(
      AssetViewGrantValidationError,
    );
    expect(await getAssetViewGrants(db, employee.employee_id)).toEqual([]);
    const audits = await db.query(sql`SELECT * FROM asset_view_grant_audits WHERE employee_id = ${employee.employee_id}`);
    expect(audits).toEqual([]);
  });

  it('rejects a grant naming an unknown project: 422, writing nothing', async () => {
    const db = await freshMigratedDb();
    const employeeId = await adminEmployee(db);

    await expect(setAssetViewGrants(db, employeeId, ['no-such-project'], null)).rejects.toThrow(AssetViewGrantValidationError);
    expect(await getAssetViewGrants(db, employeeId)).toEqual([]);
  });

  it('returns null for an unknown employee', async () => {
    const db = await freshMigratedDb();
    expect(await setAssetViewGrants(db, 'no-such-employee', [], null)).toBeNull();
  });
});
