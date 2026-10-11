/** Transport ends only response waiting. It never cancels accepted work or proves nonexecution. */
export const GATEWAY_RESPONSE_MS = 60_000;
export const MAX_GATEWAY_RESPONSE_MS = 300_000;
export const MAX_ADMISSION_MS = 30_000;
export function boundedGatewayMs(input: number): number {
  if (!Number.isSafeInteger(input) || input < 2 || input > MAX_GATEWAY_RESPONSE_MS) throw new Error('invalid gateway response deadline');
  return input;
}
/** Half the transport budget is reserved for node refusal, persistence and return transport. */
export function admissionBudgetMs(transportMs: number): number {
  return Math.min(MAX_ADMISSION_MS, Math.floor(boundedGatewayMs(transportMs) / 2));
}
/** Additive wire duration: no cross-machine wall-clock assumption and no peer-controlled timer ceiling. */
export function boundedAdmissionMs(input: unknown): number {
  if (input === undefined) return MAX_ADMISSION_MS; // Historical gateway compatibility.
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > MAX_ADMISSION_MS) throw new Error('invalid coordinator admission deadline');
  return input;
}
