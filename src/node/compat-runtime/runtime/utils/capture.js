// DEX policy: telemetry is absent, independently of persisted configuration.
// Compatibility exports for MIT-derived handlers; no network, identifiers or timers.
export async function capture() {}
export const capture_call_tool = capture;
export const capture_ui_event = capture;
export const captureRemote = capture;
export function runInUiOriginCallContext(fn) { return fn(); }
export function isInsideUiOriginCall() { return false; }
