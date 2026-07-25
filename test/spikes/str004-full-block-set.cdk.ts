import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies } from 'aws-cdk-lib';
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
