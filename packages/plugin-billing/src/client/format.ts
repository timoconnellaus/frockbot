/** One cent, in the micro-dollars the ledger records. */
const CENT_IN_MICROS_V1 = 10_000;

const USD_V1 = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Money, to the cent — except when rounding to the cent would say nothing
 * happened.
 *
 * The ledger counts micro-dollars and a short Turn costs a few hundred of
 * them, so two cents' worth of conversation used to render as "$0.00" beside
 * a list of Bots that had plainly run. "<$0.01" is the honest reading of a
 * real, sub-cent amount; exactly zero still reads as zero, because that is a
 * different fact. Totals are never floored to build a bigger number: every
 * figure here is the sum of what was recorded.
 */
export function formatCostV1(costMicros: number): string {
  if (costMicros > 0 && costMicros < CENT_IN_MICROS_V1) return "<$0.01";
  if (costMicros < 0 && costMicros > -CENT_IN_MICROS_V1) return ">-$0.01";
  return USD_V1.format(costMicros / 1_000_000);
}

export function shortModelNameV1(value: string): string {
  const slash = value.indexOf("/");
  return slash < 0 ? value : value.slice(slash + 1);
}
