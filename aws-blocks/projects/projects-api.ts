// STR-031: the project registry's business logic, sitting between the
// `projects` table (migrations/005_members_projects.sql) and the HTTP
// layer (aws-blocks/projects/projects-routes.ts) -- kept separate so it's
// testable with a plain Database, no HTTP dispatch required (test/projects/
// projects-api.test.ts). Mirrors the finance/books-api.ts + finance/
// books-routes.ts split.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { ValidationError } from '../http/problem-response';

/** The Admin OpenAPI's Project shape (components/schemas/Project). */
export interface Project {
  project_id: string;
  name: string;
  description?: string;
}

/** The Admin OpenAPI's ProjectInput shape. */
export interface ProjectInput {
  name?: string;
  description?: string | null;
}

/** Domain rejection for a create/update carrying an invalid attribute.
 * Nothing is written when this is thrown. */
export class ProjectValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
}

function toProject(row: ProjectRow): Project {
  const project: Project = { project_id: row.id, name: row.name };
  if (row.description !== null) project.description = row.description;
  return project;
}

/** `POST /projects` -- a project is created under the (single) society. */
export async function createProject(db: Database, input: ProjectInput): Promise<Project> {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new ProjectValidationError('name is required.');
  }

  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO projects (id, name, description) VALUES (${id}, ${input.name ?? null}, ${input.description ?? null})`,
  );
  const project = await getProject(db, id);
  return project!;
}

/** `GET /projects/{projectId}` -- a single project, or `null` if it doesn't exist. */
export async function getProject(db: Database, projectId: string): Promise<Project | null> {
  const row = await db.queryOne<ProjectRow>(sql`SELECT * FROM projects WHERE id = ${projectId}`);
  return row ? toProject(row) : null;
}

/** `GET /projects` -- every project. */
export async function listProjects(db: Database): Promise<Project[]> {
  const rows = await db.query<ProjectRow>(sql`SELECT * FROM projects ORDER BY id`);
  return rows.map(toProject);
}

/** `PATCH /projects/{projectId}` -- updates name/description. Returns `null`
 * if the project doesn't exist. */
export async function updateProject(db: Database, projectId: string, input: ProjectInput): Promise<Project | null> {
  const existing = await getProject(db, projectId);
  if (!existing) return null;

  await db.execute(
    sql`UPDATE projects SET
          name = ${input.name ?? existing.name},
          description = ${'description' in input ? input.description ?? null : existing.description ?? null}
        WHERE id = ${projectId}`,
  );
  return getProject(db, projectId);
}
