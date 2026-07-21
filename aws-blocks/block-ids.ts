// Single source of truth for Block IDs (STR-001 AC2).
// ⚠️ Stateful Block IDs are immutable once deployed — renaming one deletes and
// recreates the AWS resource, which is permanent data loss for Database and
// FileBucket. Treat these values as forever.
export const SCOPE_ID = 'estatly';
export const DB_BLOCK_ID = 'db';
export const DOCUMENTS_BLOCK_ID = 'documents';
