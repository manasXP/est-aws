// STR-067: the swappable push-provider interface (AC4) -- the due-date
// reminder dispatch (aws-blocks/payments/reminders.ts) sends through this
// interface only, never a concrete provider SDK, so swapping the real
// provider in with the mobile milestone (E16/E17) is a backend-only change
// with no run-logic edits. FakePushAdapter is the test/local double; no
// push-provider SDK types appear anywhere in this file.
export interface PushNotification {
  title: string;
  body: string;
}

export interface PushAdapter {
  send(pushToken: string, notification: PushNotification): Promise<void>;
}

export class FakePushAdapter implements PushAdapter {
  readonly sent: { pushToken: string; notification: PushNotification }[] = [];

  async send(pushToken: string, notification: PushNotification): Promise<void> {
    this.sent.push({ pushToken, notification });
  }
}
