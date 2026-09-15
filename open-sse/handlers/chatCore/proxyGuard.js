/**
 * Proxy options for a chat request, plus the freebuff egress guard.
 *
 * Freebuff's session tier is bound to the egress IP: a request that reaches the
 * API directly (or that silently falls back to direct when its pool fails)
 * gets the caller's real IP rate-limited into "limited mode". Two rules keep
 * that from happening:
 *
 *   1. `strictProxy` is forced on for freebuff — a failing pool must throw,
 *      never degrade to a direct connection.
 *   2. A request with no pool / relay / legacy proxy configured is refused
 *      outright, so freebuff is never used without an egress it can own.
 *
 * Set `FREEBUFF_ALLOW_DIRECT=1` to opt out of rule 2 (e.g. local use with no
 * pool). Rule 1 has no opt-out — it only matters when a proxy is in play.
 */

function flagOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

/**
 * Build the proxy options handed to an executor from a connection's
 * providerSpecificData. Field names follow what the executors read:
 * `proxyPoolId` (executor) is mapped from `connectionProxyPoolId` (auth layer).
 *
 * @param {string} provider - resolved provider id
 * @param {object} [psd] - credentials.providerSpecificData
 */
export function buildProxyOptions(provider, psd = {}) {
  const source = psd || {};
  return {
    connectionProxyEnabled: source.connectionProxyEnabled === true,
    connectionProxyUrl: source.connectionProxyUrl || "",
    connectionNoProxy: source.connectionNoProxy || "",
    vercelRelayUrl: source.vercelRelayUrl || "",
    proxyPoolId: source.connectionProxyPoolId || source.proxyPoolId || null,
    strictProxy: source.strictProxy === true || provider === "freebuff",
  };
}

/**
 * Reject freebuff requests that have no proxy to egress through.
 *
 * @returns {{status:number,message:string}|null} null when the request may proceed
 */
export function checkProxyRequirement(provider, model, proxyOptions = {}) {
  if (provider !== "freebuff") return null;
  if (flagOn(process.env.FREEBUFF_ALLOW_DIRECT)) return null;

  const hasProxy =
    !!proxyOptions.proxyPoolId ||
    !!proxyOptions.vercelRelayUrl ||
    (proxyOptions.connectionProxyEnabled === true && !!proxyOptions.connectionProxyUrl);
  if (hasProxy) return null;

  return {
    status: 503,
    message: `Freebuff requires a configured proxy pool for ${model}; direct egress is disabled to prevent limited-IP rate limits.`,
  };
}
