import { createLambdaHandler, type LambdaContext } from '@aws-blocks/blocks/lambda-handler';
import { loadConfigToProcessEnv } from '@aws-blocks/core';
import { isManagementAction, handleManagementAction } from './management-actions';

const blocksHandler = createLambdaHandler(() => import('./index.js'));

export const handler = async (event: any, context?: LambdaContext) => {
  if (isManagementAction(event)) {
    // Normal requests get this via createLambdaHandler's own internal flow;
    // a direct Invoke bypasses that entirely, so Block constructors (e.g.
    // the Database's cluster/secret ARNs) would otherwise never see their
    // config — Blocks resolves it through an S3-backed registry, not plain
    // Lambda environment variables.
    await loadConfigToProcessEnv();
    const { db } = await import('./index.js');
    return handleManagementAction(event, db);
  }
  return blocksHandler(event, context);
};
