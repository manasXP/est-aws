import { describe, it, expect } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { Scope, AppSetting } from '@aws-blocks/blocks';
import type { PaymentProvider } from '../../aws-blocks/payments/payment-provider';
import { FakePaymentProvider } from '../../aws-blocks/payments/fake-payment-provider';
import { RazorpayTestModeAdapter } from '../../aws-blocks/payments/razorpay-adapter';

// STR-091 — the provider-neutral payment interface (PaymentProvider) plus its
// two implementations, FakePaymentProvider (every later story's test double)
// and RazorpayTestModeAdapter (the real, test-mode-credentialed adapter).
// This story ships no HTTP route -- these are unit tests of the interface's
// shape and the adapter's pure webhook-signature verification only.

/** Type-level assertion (AC1): a caller written only against PaymentProvider
 * compiles unchanged against either implementation -- no Razorpay-specific
 * shape leaks through. */
function acceptsProvider(p: PaymentProvider): PaymentProvider {
  return p;
}

function freshRazorpayCredentials() {
  const scope = new Scope(`str-091-payment-provider-test-${randomUUID()}`);
  return {
    keyId: new AppSetting<string>(scope, 'key-id', { secret: true }),
    keySecret: new AppSetting<string>(scope, 'key-secret', { secret: true }),
    webhookSecret: new AppSetting<string>(scope, 'webhook-secret', { secret: true }),
  };
}

describe('PaymentProvider', () => {
  // T-U1
  it('is satisfied by both FakePaymentProvider and RazorpayTestModeAdapter with no caller-visible difference', () => {
    const fake = acceptsProvider(new FakePaymentProvider());
    const razorpay = acceptsProvider(new RazorpayTestModeAdapter(freshRazorpayCredentials()));
    expect(fake).toBeInstanceOf(FakePaymentProvider);
    expect(razorpay).toBeInstanceOf(RazorpayTestModeAdapter);
  });

  it('FakePaymentProvider.createIntent returns a {providerIntentId, providerParams} shape with deterministic ids', async () => {
    const provider = new FakePaymentProvider();
    const first = await provider.createIntent({ amount: '1250.00' });
    const second = await provider.createIntent({ amount: '500.00' });

    expect(first.providerIntentId).toBe('fake-intent-1');
    expect(second.providerIntentId).toBe('fake-intent-2');
    expect(first).toHaveProperty('providerParams');
    expect(second).toHaveProperty('providerParams');

    // AC2: no Razorpay-specific field name anywhere in the returned shape's
    // own keys (the interface's own types name none either).
    expect(Object.keys(first)).toEqual(['providerIntentId', 'providerParams']);
    expect(Object.keys(first)).not.toContain('razorpay_order_id');
    expect(Object.keys(first)).not.toContain('order_id');
  });

  // T-U2
  it('RazorpayTestModeAdapter.verifyWebhookSignature accepts a payload signed with the configured webhook secret', async () => {
    const credentials = freshRazorpayCredentials();
    await credentials.webhookSecret.put('a-known-test-secret');
    const adapter = new RazorpayTestModeAdapter(credentials);

    const rawBody = JSON.stringify({ event: 'payment.captured', payload: { id: 'pay_123' } });
    const correctSignature = createHmac('sha256', 'a-known-test-secret').update(rawBody).digest('hex');

    expect(await adapter.verifyWebhookSignature(rawBody, correctSignature)).toBe(true);
  });

  it('RazorpayTestModeAdapter.verifyWebhookSignature rejects a payload signed with a different secret', async () => {
    const credentials = freshRazorpayCredentials();
    await credentials.webhookSecret.put('a-known-test-secret');
    const adapter = new RazorpayTestModeAdapter(credentials);

    const rawBody = JSON.stringify({ event: 'payment.captured', payload: { id: 'pay_123' } });
    const wrongSignature = createHmac('sha256', 'a-different-secret').update(rawBody).digest('hex');

    expect(await adapter.verifyWebhookSignature(rawBody, wrongSignature)).toBe(false);
  });

  it('RazorpayTestModeAdapter.verifyWebhookSignature rejects the correct signature over an altered payload', async () => {
    const credentials = freshRazorpayCredentials();
    await credentials.webhookSecret.put('a-known-test-secret');
    const adapter = new RazorpayTestModeAdapter(credentials);

    const rawBody = JSON.stringify({ event: 'payment.captured', payload: { id: 'pay_123' } });
    const signature = createHmac('sha256', 'a-known-test-secret').update(rawBody).digest('hex');
    const tamperedBody = JSON.stringify({ event: 'payment.captured', payload: { id: 'pay_124' } });

    expect(await adapter.verifyWebhookSignature(tamperedBody, signature)).toBe(false);
  });

  // T-U3
  describe('FakePaymentProvider webhook sign/verify', () => {
    it('accepts a payload signed by its own signWebhookPayload', async () => {
      const provider = new FakePaymentProvider();
      const rawBody = JSON.stringify({ type: 'payment.captured', providerIntentId: 'fake-intent-1' });
      const signature = provider.signWebhookPayload(rawBody);

      expect(await provider.verifyWebhookSignature(rawBody, signature)).toBe(true);
    });

    it('rejects a signature computed over a payload altered after signing', async () => {
      const provider = new FakePaymentProvider();
      const rawBody = JSON.stringify({ type: 'payment.captured', providerIntentId: 'fake-intent-1' });
      const signature = provider.signWebhookPayload(rawBody);
      const alteredBody = JSON.stringify({ type: 'payment.captured', providerIntentId: 'fake-intent-2' });

      expect(await provider.verifyWebhookSignature(alteredBody, signature)).toBe(false);
    });

    it('parseWebhookEvent round-trips the fields a caller signed', () => {
      const provider = new FakePaymentProvider();
      const rawBody = JSON.stringify({ type: 'payment.captured', providerIntentId: 'fake-intent-1' });

      expect(provider.parseWebhookEvent(rawBody)).toEqual({ type: 'payment.captured', providerIntentId: 'fake-intent-1' });
    });
  });
});
