import {
  Scope,
  Database,
  FileBucket,
  AuthCognito,
  CronJob,
  AsyncJob,
  EmailClient,
  AppSetting,
  Logger,
  Metrics,
  Dashboard,
  RawRoute,
} from '@aws-blocks/blocks';

// STR-004 Q1 spike only — NOT the real app. A throwaway scope declaring every
// mapped Block together, deployed once to a scratch ap-south-1 stack to prove
// the full set provisions successfully, then torn down (AC4). The real
// aws-blocks/index.ts stays minimal — Blocks join it only when their
// consuming story arrives (STR-001).
const scope = new Scope('str004spike');

export const db = new Database(scope, 'db');
export const docs = new FileBucket(scope, 'docs');
export const auth = new AuthCognito(scope, 'auth');
export const heartbeat = new CronJob(scope, 'heartbeat', {
  schedule: 'rate(1 day)',
  handler: async () => {
    console.log('STR-004 spike heartbeat');
  },
});
export const job = new AsyncJob(scope, 'job', {
  handler: async (payload: unknown) => {
    console.log('STR-004 spike job', payload);
  },
});
export const email = new EmailClient(scope, 'email', {
  fromAddress: 'spike@example.com',
});
export const setting = new AppSetting(scope, 'setting', { value: 'str004' });
export const logger = new Logger(scope, 'logger');
export const metrics = new Metrics(scope, 'metrics');
export const dashboard = new Dashboard(scope, 'dashboard');
export const health = new RawRoute(scope, 'health', {
  method: 'GET',
  path: '/str-004-spike/health',
  handler: async (context: any) => {
    context.response.send({ status: 'ok' });
  },
});
