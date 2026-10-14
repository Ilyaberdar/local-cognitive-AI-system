/** Formats an amount of cents as dollars: 105 → "$1.05", -250 → "-$2.50". */
export function formatMoney(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `$${dollars}.${rest}`;
}
