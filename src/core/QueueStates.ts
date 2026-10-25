export type QueueState =
  | "queued"
  | "native_search"
  | "waiting_auth"
  | "submitted"
  | "pending"
  | "downloading"
  | "done"
  | "review"
  | "failed"
  | "cancelled";

const TERMINAL_STATES = new Set<QueueState>(["done", "review", "failed", "cancelled"]);
const CLEARABLE_STATES = new Set<QueueState>(["done", "failed", "cancelled"]);

export function isTerminalState(state: QueueState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isClearableState(state: QueueState): boolean {
  return CLEARABLE_STATES.has(state);
}

export function isRetryableState(state: QueueState): boolean {
  return state === "failed" || state === "cancelled";
}
