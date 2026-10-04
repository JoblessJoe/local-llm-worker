// Money helpers. Amounts are integer cents.

export function formatCents(cents, currency = 'EUR') {
  if (!Number.isInteger(cents)) throw new TypeError('cents must be an integer');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')} ${currency}`;
}
