import { createHmac, timingSafeEqual } from 'node:crypto';

// STR-091: the provider-neutral payment interface (E10's first story) --
// every later E10 story (initiation, webhook settlement, reconciliation)
// codes against this boundary only, never a concrete provider SDK, so
// swapping the real provider (Razorpay, and the evaluated Cashfree fallback)
// is a backend-only change (AC4). No Razorpay-specific field name appears
// anywhere in these types (AC2).

export interface CreateIntentParams {
  amount: string; // decimal string via aws-blocks/money.ts, never a float
}

export interface CreateIntentResult {
  providerIntentId: string;
  providerParams: Record<string, unknown>; // opaque at this boundary -- no Razorpay-specific field name here (AC2)
}

export interface WebhookEvent {
  type: string;
  providerIntentId: string;
}

export interface ProviderIntentStatus {
  status: 'created' | 'paid' | 'failed';
}

export interface PaymentProvider {
  createIntent(params: CreateIntentParams): Promise<CreateIntentResult>;
  // STR-091: async, not the story's literal synchronous signature -- see
  // razorpay-adapter.ts's header comment for why (the webhook secret comes
  // from an async AppSetting.get()).
  verifyWebhookSignature(rawBody: string, signatureHeader: string): Promise<boolean>;
  parseWebhookEvent(rawBody: string): WebhookEvent;
  getIntentStatus(providerIntentId: string): Promise<ProviderIntentStatus>;
}

/** Constant-time HMAC-SHA256 signature check -- never use `===` on a computed
 * digest (timing side-channel on a security-sensitive comparison). Returns
 * false (never throws) on any length mismatch or malformed hex input. */
export function verifyHmacSignature(secret: string, rawBody: string, signatureHeader: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signatureHeader, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
