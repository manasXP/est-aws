import { createHmac } from 'node:crypto';
import type {
  PaymentProvider,
  CreateIntentParams,
  CreateIntentResult,
  WebhookEvent,
  ProviderIntentStatus,
} from './payment-provider';
import { verifyHmacSignature } from './payment-provider';

// STR-091: the FakePaymentProvider test double -- every later E10 story's
// tests construct one of these rather than a RazorpayTestModeAdapter, per
// this repo's FakePushAdapter precedent (aws-blocks/notifications/push-adapter.ts).

export class FakePaymentProvider implements PaymentProvider {
  private readonly webhookSecret = 'fake-test-webhook-secret';
  private counter = 0;
  readonly createdIntents: { providerIntentId: string; params: CreateIntentParams }[] = [];

  async createIntent(params: CreateIntentParams): Promise<CreateIntentResult> {
    const providerIntentId = `fake-intent-${++this.counter}`; // deterministic, not randomUUID
    this.createdIntents.push({ providerIntentId, params });
    return { providerIntentId, providerParams: { fake: true } };
  }

  /** Test helper (not part of PaymentProvider) -- signs a payload the fake's
   * own verifyWebhookSignature will accept, using the same shared HMAC
   * helper the real adapter uses, so later stories' tests can build a fully
   * signed fake webhook delivery without importing Razorpay-specific code. */
  signWebhookPayload(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }

  /** STR-094 test helper (not part of PaymentProvider) -- builds the raw JSON
   * body for a fake webhook delivery carrying every WebhookEvent field, and
   * signs it, so a test can construct a fully-formed signed delivery in one
   * call rather than hand-rolling JSON + signWebhookPayload separately. */
  buildSignedWebhook(event: WebhookEvent): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(event);
    return { rawBody, signature: this.signWebhookPayload(rawBody) };
  }

  async verifyWebhookSignature(rawBody: string, signatureHeader: string): Promise<boolean> {
    return verifyHmacSignature(this.webhookSecret, rawBody, signatureHeader);
  }

  parseWebhookEvent(rawBody: string): WebhookEvent {
    const body = JSON.parse(rawBody);
    return {
      type: body.type,
      eventId: body.eventId,
      providerIntentId: body.providerIntentId,
      amount: body.amount,
      failureReason: body.failureReason,
    };
  }

  async getIntentStatus(_providerIntentId: string): Promise<ProviderIntentStatus> {
    return { status: 'created' };
  }
}
