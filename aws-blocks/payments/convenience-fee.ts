// STR-093: convenience fee itemization -- the seam STR-092's Refactor note
// anticipated between lockChargesForPayment and PaymentProvider.createIntent
// in aws-blocks/payments/payment-initiation.ts. Payments spec's "Decisions":
// UPI carries zero MDR (never a fee, regardless of configuration); card/
// netbanking gateway fees are passed to the member at checkout unless the
// society's absorb-fees toggle is on. Reads the payment_settings singleton
// (migrations/031_payment_settings.sql), the same shape as aws-blocks/
// payments/charges.ts's getMaintenanceFee over charge_settings.
import { sql } from '@aws-blocks/blocks';
import type { Database, Transaction } from '@aws-blocks/blocks';
import { parseMoney, formatMoney } from '../money';

export type PaymentMethod = 'upi' | 'card' | 'netbanking';

export interface PaymentSettings {
  convenienceFeePercent: string;
  absorbFees: boolean;
}

export async function getPaymentSettings(db: Database | Transaction): Promise<PaymentSettings> {
  const row = await db.queryOne<{ convenience_fee_percent: string; absorb_fees: boolean }>(
    sql`SELECT convenience_fee_percent::text AS convenience_fee_percent, absorb_fees FROM payment_settings WHERE id = 'default'`,
  );
  if (!row) throw new Error('payment_settings singleton row is missing — this should never happen outside manual intervention');
  return { convenienceFeePercent: row.convenience_fee_percent, absorbFees: row.absorb_fees };
}

export interface ConvenienceFeeResult {
  fee: string;
  totalAmount: string;
}

/**
 * `convenience_fee_percent` is a NUMERIC(5,2) read back as a decimal string
 * like "2.50" (meaning 2.50%). `parseMoney` already parses any
 * integer-dot-two-decimals string into exact integer hundredths with no
 * float -- reused here (not for money, but for the same exact-two-decimals
 * shape) to get "2.50" as 250 hundredths-of-a-percent without inventing a
 * second bigint parser: `fee_paise = round_half_up(base_paise * 250 /
 * 10000)`, i.e. base * 2.50%. Round-half-up mirrors aws-blocks/finance/
 * receipts.ts's computeGstTaxLines.
 */
export async function computeConvenienceFee(
  db: Database | Transaction,
  paymentMethod: PaymentMethod,
  baseAmount: string,
): Promise<ConvenienceFeeResult> {
  // Zero MDR on UPI P2M (Payments spec) -- always fee-free, regardless of the
  // society's configuration, so this short-circuits before any DB read.
  if (paymentMethod === 'upi') {
    return { fee: '0.00', totalAmount: baseAmount };
  }

  const settings = await getPaymentSettings(db);
  if (settings.absorbFees) {
    return { fee: '0.00', totalAmount: baseAmount };
  }

  const basePaise = parseMoney(baseAmount);
  const percentHundredths = parseMoney(settings.convenienceFeePercent);
  const scaled = basePaise * percentHundredths;
  const q = scaled / 10000n;
  const r = scaled % 10000n;
  const feePaise = r * 2n >= 10000n ? q + 1n : q;

  return { fee: formatMoney(feePaise), totalAmount: formatMoney(basePaise + feePaise) };
}
