/**
 * Proxy options for a chat request.
 *
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
    strictProxy: source.strictProxy === true,
  };
}
