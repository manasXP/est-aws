import { Scope, Database, FileBucket } from '@aws-blocks/blocks';
import { SCOPE_ID, DB_BLOCK_ID, DOCUMENTS_BLOCK_ID } from './block-ids';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Scope below to see the docstring with complete Building Block index

// Estatly deploys one stack per society — single scope, no tenancy machinery,
// no society_id anywhere. The society is a deployment concern (EST-Deploy).
const scope = new Scope(SCOPE_ID);

// The two stateful Blocks, fixed from commit one (IDs are immutable — see
// block-ids.ts). Other mapped Blocks (AuthCognito, CronJob, AsyncJob,
// EmailClient, AppSetting, Logger/Metrics/Dashboard) join when their consuming
// stories arrive — no speculative declarations.
export const db = new Database(scope, DB_BLOCK_ID);
export const documents = new FileBucket(scope, DOCUMENTS_BLOCK_ID);
