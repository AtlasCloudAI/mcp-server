/**
 * Process-wide facts the API client and the telemetry module both need, kept
 * in a module with no imports so neither has to import the other.
 */

export interface ClientState {
  name?: string;
  version?: string;
  platform: string;
  protocolVersion?: string;
}

export const clientState: ClientState = { platform: "unknown" };

type AccountListener = (accountId: string) => void;
let accountListener: AccountListener | undefined;

export function onAccountSeen(listener: AccountListener): void {
  accountListener = listener;
}

/** The API client calls this when a response names the account the key belongs to. */
export function noteAccount(accountId: unknown): void {
  if (typeof accountId === "string" && accountId.trim() !== "") accountListener?.(accountId.trim());
  else if (typeof accountId === "number" && Number.isFinite(accountId)) accountListener?.(String(accountId));
}

type AuthedSuccessListener = () => void;
let authedSuccessListener: AuthedSuccessListener | undefined;

export function onAuthedSuccess(listener: AuthedSuccessListener): void {
  authedSuccessListener = listener;
}

/** The API client calls this after any request that carried the API key and came back 2xx. */
export function noteAuthedSuccess(): void {
  authedSuccessListener?.();
}
