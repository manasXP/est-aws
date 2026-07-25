import { mkdirSync, writeFileSync } from 'node:fs';
import { startSandbox } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// CI's own sandbox stack must be the same stack on every run — not a fresh
// one per invocation (`getSandboxId`'s default is per-machine and random).
// Fixing the id here, before startSandbox resolves it, makes every CI run
// redeploy the one persistent `estatly-sandbox`-equivalent stack.
mkdirSync(join(__dirname, '..', '..', '.blocks-sandbox'), { recursive: true });
writeFileSync(join(__dirname, '..', '..', '.blocks-sandbox', 'sandbox-id.txt'), 'sandbox');

startSandbox({
  backendPath: join(__dirname, '..', 'index.cdk.ts'),
  deployOnly: true
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
