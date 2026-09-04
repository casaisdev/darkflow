import type { Fees } from "@/types/stream";

/**
 * Effective priority fee per gas, in wei.
 *
 * Ranking on `maxPriorityFeePerGas` alone is wrong. Under EIP-1559 the tip a
 * transaction actually pays is capped by whatever is left of `maxFeePerGas`
 * after the base fee, so a transaction advertising a huge tip under a tight fee
 * cap pays far less than it claims — and would otherwise sit at the bright end
 * of the luminance ramp while never being competitive.
 *
 * Legacy transactions price base fee and tip together, so the tip is whatever
 * `gasPrice` clears the base fee by.
 *
 * Clamped at zero: a transaction priced below the base fee is not includable at
 * all, and a negative value has no place on a luminance ramp.
 */
export function effectivePriorityFee(
  fees: Fees,
  baseFeePerGas: number,
): number {
  if (fees.kind === "legacy") {
    return Math.max(0, fees.gasPrice - baseFeePerGas);
  }
  return Math.max(
    0,
    Math.min(fees.maxPriorityFeePerGas, fees.maxFeePerGas - baseFeePerGas),
  );
}

/**
 * What a transaction offers before any base fee is known.
 *
 * Used only for the render pool's eviction ordering, which has to rank
 * transactions that arrived since the last block and therefore has no current
 * base fee to work from. Not a substitute for `effectivePriorityFee`.
 */
export function offeredFee(fees: Fees): number {
  return fees.kind === "legacy" ? fees.gasPrice : fees.maxFeePerGas;
}
