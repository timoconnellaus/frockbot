/** The temporary fixed Computer tariff used until a trustworthy meter exists. */
export const COMPUTER_TARIFF = {
  providerCeilingMicrosPerHour: 1_328_300,
  activeMicrosPerHour: 2_750_000,
  activeUsdPerHour: 2.75,
  viewerOpenSeconds: 30,
  viewerRenewSeconds: 30,
  storageIncludedGb: 100,
} as const;

export function computerChargeMicros(milliseconds: number): number {
  return Math.ceil(
    (COMPUTER_TARIFF.activeMicrosPerHour * milliseconds) / 3_600_000,
  );
}

export function computerCostMicros(milliseconds: number): number {
  return Math.ceil(
    (COMPUTER_TARIFF.providerCeilingMicrosPerHour * milliseconds) / 3_600_000,
  );
}
