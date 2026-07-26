import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { setAssetViewGrants } from '../../aws-blocks/employees/asset-view-grants-api';
import { listAssetsVisibleToEmployee } from '../../aws-blocks/assets/asset-visibility';
import { documents } from '../contract/harness';

// STR-057 — Role-scoped asset visibility, unit cases. Follows the STR-051
// test pattern (test/assets/assets-api.test.ts): fresh Database + Scope per
// test, baseline + domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-057-visibility-test-${randomUUID()}`), 'db');
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

// T-U1: covers TC-AST-042 -- the EC all-projects asset view is served on
// the admin panel only, never on the mobile surface in v1 (AC3). The
// all-projects read is GET /v1/assets with no project_id filter (already
// built by STR-051, no new code here) -- this test's job is the negative
// half: no mobile `/ec` asset path exists to expose it there.
describe('STR-057 T-U1 — EC all-projects view is admin-only', () => {
  it('the mobile OpenAPI declares no /ec asset surface', () => {
    const mobilePaths = Object.keys(documents.mobile.paths ?? {});
    expect(mobilePaths.some(path => path.startsWith('/ec'))).toBe(false);
  });

  it('GET /v1/assets (admin, no project_id filter) spans every project', async () => {
    const db = await freshMigratedDb();
    const projectA = await createProject(db, { name: 'Project A' });
    const projectB = await createProject(db, { name: 'Project B' });
    const { listAssets } = await import('../../aws-blocks/assets/assets-api');
    await createAsset(db, { project_id: projectA.project_id, type: 'flat', label: 'A-1' });
    await createAsset(db, { project_id: projectB.project_id, type: 'plot', label: 'B-1' });

    const items = await listAssets(db);
    expect(items.map(a => a.project_id).sort()).toEqual([projectA.project_id, projectB.project_id].sort());
  });
});

// T-U2: covers TC-AST-043 -- an employee with a per-project asset-view
// grant sees that project's assets and no others; without a grant, none.
describe('STR-057 T-U2 — employee asset-view grants scope the read', () => {
  async function grantableEmployee(db: Database): Promise<string> {
    const employee = await createEmployee(db, { name: 'Granted Employee' });
    await setEmployeeCapabilities(db, employee.employee_id, ['data-entry']);
    return employee.employee_id;
  }

  it('an employee with a grant for project P sees P\'s assets and no others', async () => {
    const db = await freshMigratedDb();
    const projectP = await createProject(db, { name: 'Project P' });
    const projectQ = await createProject(db, { name: 'Project Q' });
    const assetP = await createAsset(db, { project_id: projectP.project_id, type: 'flat', label: 'P-1' });
    await createAsset(db, { project_id: projectQ.project_id, type: 'flat', label: 'Q-1' });
    const employeeId = await grantableEmployee(db);
    await setAssetViewGrants(db, employeeId, [projectP.project_id], null);

    const visibleP = await listAssetsVisibleToEmployee(db, employeeId, projectP.project_id);
    expect(visibleP.map(a => a.asset_id)).toEqual([assetP.asset_id]);

    const visibleQ = await listAssetsVisibleToEmployee(db, employeeId, projectQ.project_id);
    expect(visibleQ).toEqual([]);
  });

  it('an employee without any grant sees none', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Ungranted Project' });
    await createAsset(db, { project_id: project.project_id, type: 'villa', label: 'V-1' });
    const employeeId = await grantableEmployee(db);

    const visible = await listAssetsVisibleToEmployee(db, employeeId, project.project_id);
    expect(visible).toEqual([]);
  });
});
