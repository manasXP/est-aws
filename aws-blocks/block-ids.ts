// Single source of truth for Block IDs (STR-001 AC2).
// ⚠️ Stateful Block IDs are immutable once deployed — renaming one deletes and
// recreates the AWS resource, which is permanent data loss for Database and
// FileBucket. Treat these values as forever.
export const SCOPE_ID = 'estatly';
export const DB_BLOCK_ID = 'db';
export const DOCUMENTS_BLOCK_ID = 'documents';
// STR-045: the admin/mobile Cognito user pool. Not stateful in the
// Database/FileBucket sense, but renaming it replaces the pool — which
// orphans every enrolled admin account — so treat it as fixed too.
export const AUTH_BLOCK_ID = 'auth';
