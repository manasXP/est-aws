import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies } from 'aws-cdk-lib';
import { CfnDBCluster } from 'aws-cdk-lib/aws-rds';
import { BlocksStack } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// STR-004 Q1 spike deploy entrypoint. Separate from aws-blocks/index.cdk.ts —
// distinct stack name, deployed and destroyed standalone, never touches the
// project's real sandbox/prod stack state (.blocks/config.json,
// .blocks-sandbox/sandbox-id.txt).
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const stackName = 'str004-spike-fullblockset';
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'str004-full-block-set.handler.ts'),
  backendCDKPath: join(__dirname, 'str004-full-block-set.ts'),
});

// Everything deletable — this stack is torn down immediately after evidence
// is captured (AC4), no data worth retaining.
RemovalPolicies.of(blocksStack).destroy();

// Escape hatch, spike-only: @aws-blocks/bb-data@0.2.2 hardcodes Aurora
// PostgreSQL 16.4 (rds.AuroraPostgresEngineVersion.VER_16_4 in its infra.ts),
// which AWS has deprecated everywhere — confirmed absent in ap-south-1,
// us-east-1, and eu-west-1 via `aws rds describe-db-engine-versions`. No
// newer @aws-blocks/bb-data version exists to fix it, and DatabaseOptions
// exposes no override. Unrelated to the ap-south-1 question this spike is
// actually answering, so it's worked around here rather than blocking Q1 on
// an upstream package bug. This is a genuine finding for the architecture
// doc, not something to carry into the real app.
const dbCluster = blocksStack.node.findAll().find((c): c is CfnDBCluster => c instanceof CfnDBCluster);
if (dbCluster) {
  dbCluster.addPropertyOverride('EngineVersion', '16.13');
}
