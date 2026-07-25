import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { ManagementActionName } from '../../../aws-blocks/management-actions';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUTS_PATH = join(__dirname, '../../../.blocks-sandbox/outputs.json');

export interface DeployedStackOutputs {
  gatewayUrl: string;
  handlerFunctionName: string;
}

export function readDeployedStackOutputs(): DeployedStackOutputs {
  const outputs = JSON.parse(readFileSync(OUTPUTS_PATH, 'utf-8'));
  const stackOutputs = Object.values(outputs)[0] as Record<string, string>;
  const { GatewayUrl: gatewayUrl, HandlerFunctionName: handlerFunctionName } = stackOutputs;
  if (!gatewayUrl || !handlerFunctionName) {
    throw new Error(`GatewayUrl/HandlerFunctionName missing from ${OUTPUTS_PATH} — is this running against a real deployed sandbox stack?`);
  }
  return { gatewayUrl, handlerFunctionName };
}

const client = new LambdaClient({});

// Same IAM-invoke mechanism as aws-blocks/scripts/invoke-deploy-migration.ts
// — going through the deployed Lambda (not a second, external connection to
// Aurora) means this test never needs to resolve cluster/secret ARNs or
// Blocks' own S3-backed config-registry indirection itself.
export async function invokeManagementAction(functionName: string, action: ManagementActionName): Promise<unknown> {
  const response = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: new TextEncoder().encode(JSON.stringify({ action }))
    })
  );
  const payload = response.Payload ? JSON.parse(new TextDecoder().decode(response.Payload)) : undefined;
  if (response.FunctionError || (payload && typeof payload === 'object' && 'errorMessage' in payload)) {
    throw new Error(`Management action "${action}" failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}
