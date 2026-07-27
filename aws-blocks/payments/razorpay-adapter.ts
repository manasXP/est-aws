import type { AppSetting } from '@aws-blocks/blocks';
import type {
  PaymentProvider,
  CreateIntentParams,
  CreateIntentResult,
  WebhookEvent,
  ProviderIntentStatus,
} from './payment-provider';
import { verifyHmacSignature } from './payment-provider';
import { parseMoney } from '../money';

// STR-091: the real, test-mode-credentialed PaymentProvider implementation.
// No Razorpay SDK/HTTP type leaks outside this file (Definition of Done).
// The three credentials are injected as AppSetting(secret: true) instances
// rather than constructed here -- construction happens in aws-blocks/index.ts
// once a consuming story (STR-092) actually needs a wired instance; nothing
// in this repo calls createIntent/getIntentStatus/etc. yet.

export interface RazorpayCredentials {
  keyId: AppSetting<string>;
  keySecret: AppSetting<string>;
  webhookSecret: AppSetting<string>;
}

const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

export class RazorpayTestModeAdapter implements PaymentProvider {
  constructor(private readonly credentials: RazorpayCredentials) {}

  async createIntent(params: CreateIntentParams): Promise<CreateIntentResult> {
    const [keyId, keySecret] = await Promise.all([this.credentials.keyId.get(), this.credentials.keySecret.get()]);
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    // Razorpay's Orders API takes `amount` as an integer in the smallest
    // currency subunit (paise for INR), not a decimal string -- money.ts's
    // parseMoney already gives us that as a bigint; Number() is safe here,
    // no realistic receipt amount approaches Number.MAX_SAFE_INTEGER paise.
    const amountPaise = Number(parseMoney(params.amount));
    const response = await fetch(`${RAZORPAY_API_BASE}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR' }),
    });
    if (!response.ok) {
      throw new Error(`Razorpay order creation failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    return { providerIntentId: body.id, providerParams: body };
  }

  // STR-091 design note: this interface method is `Promise<boolean>`, not the
  // story's literal synchronous `boolean` -- resolving webhookSecret requires
  // an async AppSetting.get() call, and caching the secret eagerly at
  // construction time would go stale across a runtime `.put()` rotation. See
  // aws-blocks/payments/payment-provider.ts's PaymentProvider interface.
  async verifyWebhookSignature(rawBody: string, signatureHeader: string): Promise<boolean> {
    const webhookSecret = await this.credentials.webhookSecret.get();
    return verifyHmacSignature(webhookSecret, rawBody, signatureHeader);
  }

  parseWebhookEvent(rawBody: string): WebhookEvent {
    const body = JSON.parse(rawBody);
    return { type: body.event, providerIntentId: body.payload?.payment?.entity?.order_id };
  }

  async getIntentStatus(providerIntentId: string): Promise<ProviderIntentStatus> {
    const [keyId, keySecret] = await Promise.all([this.credentials.keyId.get(), this.credentials.keySecret.get()]);
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await fetch(`${RAZORPAY_API_BASE}/orders/${providerIntentId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!response.ok) {
      throw new Error(`Razorpay order status lookup failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    const status: ProviderIntentStatus['status'] = body.status === 'paid' ? 'paid' : body.status === 'created' ? 'created' : 'failed';
    return { status };
  }
}
