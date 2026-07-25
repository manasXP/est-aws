import { Scope, AuthCognito, CronJob, AsyncJob, EmailClient, AppSetting, Logger, Metrics, Dashboard } from '@aws-blocks/blocks';

// STR-003 Q2 spike — instantiates every mapped Block not already proven by
// STR-001 (Database, FileBucket), under a scratch scope so it never collides
// with the real estatly-db/estatly-documents IDs. Compiling this file under
// TypeScript strict IS the proof (see Definition of Done); this function
// additionally instantiates each at runtime as a sanity check.

export function instantiateMappedBlocks() {
  const scope = new Scope('str-003-block-spike');

  const auth = new AuthCognito(scope, 'auth');

  const cronJob = new CronJob(scope, 'chargeRun', {
    schedule: 'rate(1 day)',
    handler: async () => {}
  });

  const asyncJob = new AsyncJob<{ periodId: string }>(scope, 'tallyExport', {
    handler: async () => {}
  });

  const emailClient = new EmailClient(scope, 'email', {
    fromAddress: 'noreply@estatly.in'
  });

  const appSetting = new AppSetting(scope, 'razorpayKey', {
    secret: true
  });

  const logger = new Logger(scope, 'logger', { level: 'info' });

  const metrics = new Metrics(scope, 'metrics', { namespace: 'estatly' });

  const dashboard = new Dashboard(scope, 'dashboard', { metrics, logger });

  return { auth, cronJob, asyncJob, emailClient, appSetting, logger, metrics, dashboard };
}
