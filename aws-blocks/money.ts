// STR-021: money is always an exact decimal string ("1250.00"), never a
// float (Finance & Compliance, "Decisions 2026-07-20"). Internally, amounts
// are represented as integer paise (`bigint`) so no `number` arithmetic ever
// touches a money value — a JS `number` cannot represent every decimal
// fraction exactly (e.g. 0.1 + 0.2 !== 0.3).

const MONEY_PATTERN = /^\d+\.\d{2}$/;

export class InvalidMoneyError extends Error {
  constructor(value: string) {
    super(`Invalid money amount: "${value}" (expected a decimal string like "1250.00")`);
    this.name = 'InvalidMoneyError';
  }
}

/** Parse a decimal string like "1250.00" into exact integer paise. */
export function parseMoney(value: string): bigint {
  if (!MONEY_PATTERN.test(value)) throw new InvalidMoneyError(value);
  const [rupees, paise] = value.split('.');
  return BigInt(rupees) * 100n + BigInt(paise);
}

/** Format integer paise back into an exact decimal string like "1250.00". */
export function formatMoney(paise: bigint): string {
  if (paise < 0n) throw new RangeError(`Cannot format a negative amount: ${paise}`);
  const rupees = paise / 100n;
  const remainder = paise % 100n;
  return `${rupees}.${remainder.toString().padStart(2, '0')}`;
}

/** Sum a list of decimal-string amounts, returning an exact decimal string. */
export function sumMoney(amounts: readonly string[]): string {
  return formatMoney(amounts.reduce((total, amount) => total + parseMoney(amount), 0n));
}

/** Compare two decimal-string amounts for exact equality. */
export function moneyEquals(a: string, b: string): boolean {
  return parseMoney(a) === parseMoney(b);
}
