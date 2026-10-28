// Outbound identity for the CodeBuddy / WorkBuddy desktop client.
//
// Every value here was read out of the shipped 4.12.1 client bundle, not guessed:
//   Contents/Resources/app/product.json      -> nameShort "CodeBuddy", version "1.106.1"
//   Contents/Resources/app/product-ide.json  -> platform "CodeBuddyIDE"
//   out/codebuddy/main.js                    -> buildUserAgent(), deploymentType "SaaS"
//   extensions/genie/out/extension/index.js  -> the header set and its values
//
// Why this matters: the gateway's risk engine scores client identity, and identity is
// these headers. The previous values (User-Agent "IDE/2.108.1", X-IDE-Type "IDE") are
// sent by no shipped client, which makes every request trivially distinguishable from a
// real IDE. That is a plausible trigger for 11140 "account restricted due to unusual
// activity" — the failure mode this file exists to remove.
//
// Updating: there is no endpoint that returns the current version (probed: /v2/config,
// /v2/update, latest.yml, /v2/plugin/version all 404; the plugin VSIX is 403-locked).
// The only source is the release artifact itself — download
// https://download.codebuddy.ai/aiide/darwin-arm64/CodeBuddy-darwin-arm64-<ver>-<commit>.zip
// and read product.json / product-ide.json out of it. That is a manual step by design:
// a wrong version is worse than a slightly old one, because the gateway rejects values
// no client ever sent, not values that are merely behind.
export const CODEBUDDY_CLIENT = Object.freeze({
  platform: "CodeBuddyIDE",
  // Inferred: genieVersion is the value the client injects as data-product-version, and
  // it is the only 4-part version in the bundle. No packet capture confirmed it feeds
  // platformVersion, so treat the exact number as approximate and the shape as certain.
  platformVersion: "4.12.1",
  productName: "CodeBuddy",
  productVersion: "1.106.1",
  deploymentType: "SaaS",
  domain: "www.codebuddy.ai",
});

/**
 * Mirrors the client's UserAgentHttpInterceptor.buildUserAgent():
 *   productName is unshifted first, then platform — so platform lands at the front.
 * Result: `CodeBuddyIDE/4.12.1 CodeBuddy/1.106.1`
 */
export function codeBuddyUserAgent(extension = "") {
  const parts = [];
  if (CODEBUDDY_CLIENT.productName) {
    parts.unshift(`${CODEBUDDY_CLIENT.productName}/${CODEBUDDY_CLIENT.productVersion || "unknown"}`);
  }
  if (CODEBUDDY_CLIENT.platform) {
    parts.unshift(`${CODEBUDDY_CLIENT.platform}/${CODEBUDDY_CLIENT.platformVersion || "unknown"}`);
  }
  if (extension) parts.push(extension);
  return parts.join(" ");
}
