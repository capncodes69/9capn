import dns from "dns";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";

// Tencent's CDN serves CodeBuddy/WorkBuddy from an A record that flips between
// the real address and the blackhole `0.0.0.1`, per resolver and per query.
// Fly's internal resolver is one that catches the blackholed answer: measured
// inside the router machine, `getent hosts www.workbuddy.ai` → 0.0.0.1 while
// 1.1.1.1, 8.8.8.8 and Cloudflare DoH all answered 43.174.57.1. Every call to
// the brand then dies as `fetch failed` / ConnectTimeoutError after undici's
// 10s connect timeout — the device flow surfaced it as "9router: no device code
// for codebuddy-intl", and the same poison would take token refresh, usage and
// chat with it. So the brand hosts are resolved through public resolvers here,
// the blackhole answer is refused, and the socket is pinned to the address we
// vetted; TLS still verifies against the hostname the caller asked for. Hosts
// outside the brands keep the system resolver untouched, and a brand host we
// cannot resolve is left to it too — the pin only ever removes a poisoned
// answer, it never invents one.
const BRAND_HOST_RE = /(?:^|\.)(?:codebuddy|workbuddy)\.ai$/;
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "1.0.0.1", "8.8.8.8"];
const BLOCKED_IPS = new Set(["0.0.0.0", "0.0.0.1", "127.0.0.1", "::", "::1"]);
const dnsCache = new Map(); // host -> { ip, expires }

/** True for the CodeBuddy / WorkBuddy hosts (any subdomain). */
export function isBrandHost(hostname) {
  return BRAND_HOST_RE.test(String(hostname || "").trim().toLowerCase());
}

/** Same test for a full URL, for the fetch path that only has one. */
export function isBrandHostUrl(url) {
  try {
    return isBrandHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function usableAddress(addresses) {
  return (addresses || []).find((address) => address && !BLOCKED_IPS.has(address)) || "";
}

/**
 * First address of `host` that is not the CDN's blackhole, asked of the public
 * resolvers one by one — "" when none of them has a usable answer, and then the
 * caller falls back to the system resolver (the behavior before the pin).
 * Successful answers are cached for `MEMORY_CONFIG.dnsCacheTtlMs` so a request
 * path pays for one lookup, not one per call; failures are never cached, so a
 * blip cannot outlive itself.
 */
export async function resolveBrandIp(host) {
  const key = String(host || "").trim().toLowerCase();
  const cached = dnsCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.ip;

  for (const server of PUBLIC_DNS_SERVERS) {
    const resolver = new dns.promises.Resolver();
    resolver.setServers([server]);
    try {
      const ip = usableAddress(await resolver.resolve4(key));
      if (ip) {
        dnsCache.set(key, { ip, expires: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
        return ip;
      }
    } catch {
      // This server could not answer for the host — ask the next one.
    }
  }
  return "";
}

/**
 * Node `lookup` callback wired in as the dispatcher's `connect.lookup`.
 * undici connects with `{ all: true }` (verified against Node's own fetch), so
 * the pinned address has to come back in the array shape as well; the single
 * shape is kept for the callers that ask without `all`.
 */
export function brandLookup(hostname, options, callback) {
  if (!isBrandHost(hostname)) return dns.lookup(hostname, options, callback);
  resolveBrandIp(hostname).then(
    (ip) => {
      if (!ip) return dns.lookup(hostname, options, callback);
      if (options && options.all) return callback(null, [{ address: ip, family: 4 }]);
      callback(null, ip, 4);
    },
    (err) => callback(err),
  );
}

let dispatcherPromise = null;

/**
 * Lazy undici dispatcher that pins brand hosts to the vetted address. Built on
 * first use so an app that never touches the brands never imports undici here,
 * and a failure to load it degrades to the ordinary egress instead of failing
 * the request.
 */
export function getBrandDispatcher() {
  if (!dispatcherPromise) {
    dispatcherPromise = import("undici")
      .then(({ Agent }) => new Agent({ connect: { lookup: brandLookup } }))
      .catch((error) => {
        console.warn(`[BrandDns] pinned dispatcher unavailable: ${error.message}`);
        return null;
      });
  }
  return dispatcherPromise;
}

/** Test helper: forget cached answers so each case starts from a clean slate. */
export function clearBrandDnsCache() {
  dnsCache.clear();
}
