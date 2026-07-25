import { beforeAll } from 'vitest';

// STR-001: the local loop must be AWS-free. Strip any ambient AWS identity so a
// passing run proves the Blocks local implementations are in play.
beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWS_')) delete process.env[key];
  }
});
