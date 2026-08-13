export type HostValidationEnvironment = "development" | "test" | "production";

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function isExactAllowedHost(
  rawHost: string | undefined,
  allowedHosts: readonly string[],
  environment: HostValidationEnvironment
): boolean {
  if (
    !rawHost ||
    rawHost !== rawHost.trim() ||
    /[\\/@?#\s]/.test(rawHost)
  ) {
    return false;
  }

  try {
    const parsed = new URL(`https://${rawHost}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    if (environment === "production" && parsed.port !== "") {
      return false;
    }
    const hostname = normalizeHostname(parsed.hostname);
    return allowedHosts.some(
      (allowedHost) => normalizeHostname(allowedHost) === hostname
    );
  } catch {
    return false;
  }
}
