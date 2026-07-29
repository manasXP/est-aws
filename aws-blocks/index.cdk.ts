import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { getSdkIdentifiers } from '@aws-blocks/blocks';
import { SCOPE_ID, AUTH_BLOCK_ID } from './block-ids';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';
import { overrideDeprecatedAuroraEngineVersion } from './known-issues/aurora-engine-version-workaround';
import { MIGRATIONS_DIR } from './migrations-runner';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = getStackName({ sandbox: sandboxMode, projectRoot });
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts')
});

// @aws-blocks/bb-data@0.2.2 hardcodes a since-removed Aurora engine version —
// every real deploy needs this patch, not just sandbox (STR-004's finding,
// applied for the first time to a real deploy here).
overrideDeprecatedAuroraEngineVersion(blocksStack);

// The Handler NodejsFunction's esbuild bundle only includes the JS
// dependency graph — migrations/*.sql never makes it into a real deploy
// without this. Mounted as a layer at /opt (management-actions.ts's
// resolveMigrationsDir() reads from there when actually running in Lambda).
const migrationsLayer = new lambda.LayerVersion(blocksStack, 'MigrationsLayer', {
  code: lambda.Code.fromAsset(join(__dirname, '..', MIGRATIONS_DIR))
});
blocksStack.handler.addLayers(migrationsLayer);

new cdk.CfnOutput(blocksStack, 'HandlerFunctionName', { value: blocksStack.handler.functionName });
new cdk.CfnOutput(blocksStack, 'GatewayUrl', { value: blocksStack.gateway.url });

// STR-045: the triple the Provisioning Runbook §4/§5 tells an operator to
// capture and register with the Society Directory, and that the admin panel
// reads as public config to sign in against this deployment's pool.
const { userPoolId, clientId } = getSdkIdentifiers({ fullId: `${SCOPE_ID}-${AUTH_BLOCK_ID}` });
new cdk.CfnOutput(blocksStack, 'CognitoUserPoolId', { value: userPoolId });
new cdk.CfnOutput(blocksStack, 'CognitoClientId', { value: clientId });
new cdk.CfnOutput(blocksStack, 'CognitoRegion', { value: blocksStack.region });

if (sandboxMode) {
  // Make all resources deletable so sandbox:destroy can clean up the entire stack.
  // This overrides removal policies and deletion protection (e.g. RDS) for every
  // resource in the stack, including any you add below.
  // Remove these lines if you want to manage teardown behavior yourself.
  RemovalPolicies.of(blocksStack).destroy();
  Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

  // Tell the runtime that cookies need cross-domain attributes (frontend on
  // localhost, API on API Gateway — different registrable domains).
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');}
