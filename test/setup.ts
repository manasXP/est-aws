import { beforeAll } from 'vitest';

// STR-001: the local loop must be AWS-free. Strip any ambient AWS identity so a
// passing run proves the Blocks local implementations are in play.
//
// STR-045: and serve this deployment's pool JWKS in-process, for the same
// reason -- token verification is now on every gated route, so without it the
// whole suite would either reach the network or 401. Installed here rather
// than per file because it is infrastructure every dispatch-based test needs:
// 20 files imported the helper and forgot to call it, which is precisely the
// trap a setup file exists to close.
beforeAll(async () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWS_')) delete process.env[key];
  }

  // Imported lazily, after the strip above: this pulls in aws-blocks/index
  // transitively, and the app must never initialize while AWS_* is still set.
  const { installJwksStub } = await import('./support/cognito-token');
  installJwksStub();
});
