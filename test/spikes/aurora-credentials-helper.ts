import { sql } from '@aws-blocks/blocks';
import type { db } from '../../aws-blocks/index';

/**
 * Proves the Database Block's own query API is the only mechanism needed to
 * reach the database — no connection string or credential is read directly
 * by this code. See test/spikes/aurora-credentials.spike.test.ts (STR-004 Q2).
 * Kept as a permanent smoke check for STR-011/STR-014's sandbox proof, not
 * deleted with the spike scope.
 */
export const checkDatabaseConnection = async (
  database: typeof db,
): Promise<{ ok: boolean }> => {
  const rows = await database.query<{ one: number }>(sql`SELECT 1 AS one`);
  return { ok: rows[0]?.one === 1 };
};
