import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputsPath = join(__dirname, '..', '..', '.blocks-sandbox', 'outputs.json');

const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8'));
const stackOutputs = Object.values(outputs)[0] as Record<string, string>;
const functionName = stackOutputs.HandlerFunctionName;
if (!functionName) {
  throw new Error(`HandlerFunctionName missing from ${outputsPath} — was the stack deployed with the STR-014 CfnOutput in place?`);
}

const client = new LambdaClient({});
const response = await client.send(
  new InvokeCommand({
    FunctionName: functionName,
    Payload: new TextEncoder().encode(JSON.stringify({ action: 'migrate' }))
  })
);

const payload = response.Payload ? JSON.parse(new TextDecoder().decode(response.Payload)) : undefined;

// A direct Lambda Invoke that throws inside the handler still returns
// StatusCode 200 with an error-shaped payload (errorMessage/errorType) —
// FunctionError is the only reliable signal, checking the payload shape
// alone would miss it.
if (response.FunctionError || (payload && typeof payload === 'object' && 'errorMessage' in payload)) {
  console.error(`[invoke-deploy-migration] FAILED: ${JSON.stringify(payload)}`);
  process.exit(1);
}

console.log(`[invoke-deploy-migration] applied: ${JSON.stringify(payload?.applied ?? [])}`);
