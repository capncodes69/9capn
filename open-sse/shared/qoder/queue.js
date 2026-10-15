/**
 * Qoder model-queue handling, reverse-engineered from qodercli 1.1.41.
 *
 * When a model is temporarily unavailable Qoder answers the inference request
 * with a `{statusCodeValue, body}` SSE envelope whose body carries:
 *
 *   { "code": "10605",
 *     "message": "{\"isQueued\":true,\"modelKey\":\"auto\",\"queueCount\":0,
 *                  \"queueType\":\"p3\",\"retryAfterSeconds\":30,
 *                  \"serviceAvailable\":false,\"subCode\":\"RESOURCE_LIMIT\",
 *                  \"waitTime\":30}",
 *     "subCode": "RESOURCE_LIMIT" }
 *
 * qodercli treats code 10605 / `isQueued:true` as a *transient* condition, not
 * a billing/quota block: it keeps the request alive, polls the model-queue
 * status endpoint, and replays the inference call once the model is ready
 * (qodercli's `ModelQueue` module; constants VrE/crE/brE/KrE below are its).
 * These helpers detect that signal and derive the wait interval so the
 * executor can hold the request open instead of failing it with a hard 403.
 *
 * The error payload is frequently double-encoded (the queue object lives
 * inside a JSON string in `message`), so every lookup walks the nested tree,
 * parsing JSON-encoded string fields as it goes — mirroring qodercli's
 * recursive `ov()`/`RrE()` parser.
 */

export const QODER_QUEUE_CODE = "10605";
export const QODER_MODEL_QUEUE_MAX_WAIT_ENV = "QODER_MODEL_QUEUE_MAX_WAIT_MS";

// qodercli: VrE = 3600000 (max wait), crE = 30000 (default retry interval),
// brE = 500 (floor), KrE = 30000 (cap).
//
// We deliberately do NOT inherit qodercli's 1h default: the queue clears in
// ~30s windows, so a gateway that holds the caller for an hour is worse than
// one that gives up and reports a retryable error. 3 minutes covers several
// windows; raise it with QODER_MODEL_QUEUE_MAX_WAIT_MS if a client can wait.
const DEFAULT_MAX_WAIT_MS = 180_000;
const DEFAULT_RETRY_MS = 30_000;
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

const NESTED_KEYS = ["error", "data", "body", "message", "cause", "result", "payload"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function toNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function toString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function toBool(v) {
  if (v === true || v === false) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function tryParse(value) {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return undefined;
  try {
    const parsed = JSON.parse(s);
    return isPlainObject(parsed) || Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseBody(body) {
  if (isPlainObject(body) || Array.isArray(body)) return body;
  return tryParse(body);
}

/**
 * Breadth-first walk over nested objects and JSON-encoded string fields.
 * Returns every plain object reachable from the root.
 */
function walkObjects(root) {
  const out = [];
  const seenObjects = new Set();
  const seenStrings = new Set();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (isPlainObject(node)) {
      if (seenObjects.has(node)) continue;
      seenObjects.add(node);
      out.push(node);
      for (const key of NESTED_KEYS) {
        const v = node[key];
        if (isPlainObject(v) || Array.isArray(v)) {
          queue.push(v);
        } else if (typeof v === "string" && !seenStrings.has(v)) {
          seenStrings.add(v);
          const parsed = tryParse(v);
          if (parsed) queue.push(parsed);
        }
      }
    } else if (Array.isArray(node)) {
      for (const item of node) {
        if (isPlainObject(item) || Array.isArray(item)) queue.push(item);
      }
    }
  }
  return out;
}

/**
 * Extract queue metadata from any nested object carrying isQueued/waitTime/
 * serviceAvailable. Returns only the fields that were present, or null.
 */
export function parseQoderQueueInfo(body) {
  const root = parseBody(body);
  if (!root) return null;
  for (const node of walkObjects(root)) {
    const isQueued = toBool(node.isQueued);
    const waitTime = toNumber(node.waitTime);
    const serviceAvailable = toBool(node.serviceAvailable);
    if (isQueued === undefined && waitTime === undefined && serviceAvailable === undefined) continue;
    const info = {
      isQueued,
      modelKey: toString(node.modelKey),
      queueCount: toNumber(node.queueCount),
      queueType: toString(node.queueType),
      serviceAvailable,
      retryAfterSeconds: toNumber(node.retryAfterSeconds),
      waitTime,
    };
    return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined));
  }
  return null;
}

/** True when the body signals code 10605 or `isQueued:true` anywhere in its tree. */
export function isQoderQueuedBody(body) {
  const root = parseBody(body);
  if (!root) return false;
  for (const node of walkObjects(root)) {
    if (toString(node.code) === QODER_QUEUE_CODE) return true;
    if (toBool(node.isQueued) === true) return true;
    const queue = node.queue;
    if (isPlainObject(queue) && toBool(queue.isQueued) === true) return true;
  }
  return false;
}

/**
 * Wait interval in ms derived from the queue signal, clamped like qodercli
 * (`mz$`/`ZrE`): retryAfterSeconds wins, then waitTime, then a 30s default,
 * bounded to [500ms, 30s].
 */
export function computeQoderQueueDelayMs(info) {
  let seconds;
  if (info) {
    if (Number.isFinite(info.retryAfterSeconds) && info.retryAfterSeconds > 0) seconds = info.retryAfterSeconds;
    else if (Number.isFinite(info.waitTime) && info.waitTime > 0) seconds = info.waitTime;
  }
  const ms = seconds !== undefined ? seconds * 1000 : DEFAULT_RETRY_MS;
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, ms));
}

/**
 * Max total time to hold a request open waiting for a queued model.
 * Overridable through `QODER_MODEL_QUEUE_MAX_WAIT_MS` (qodercli's env name;
 * see DEFAULT_MAX_WAIT_MS for why our default is not qodercli's 1h).
 */
export function qoderQueueMaxWaitMs() {
  const raw = process.env[QODER_MODEL_QUEUE_MAX_WAIT_ENV];
  if (raw == null || raw === "") return DEFAULT_MAX_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_WAIT_MS;
}

/**
 * URL of the model-queue status endpoint qodercli polls (`krE` in the CLI).
 *
 * `inferenceBase` is the host root (see qoderInferenceBase) and the endpoint
 * lives under `/algo`, like the inference endpoint — qodercli logs the
 * unprefixed contract path, but the gateway 404s that and answers 200 on
 * `/algo/api/v2/service/ask/queue/status` (verified against the live API).
 * `requestSetId` is the queue key and must be the same `request_set_id` the
 * inference body carried.
 */
export function qoderQueueStatusUrl(inferenceBase, { requestSetId, modelKey, queueType } = {}) {
  const params = new URLSearchParams();
  if (requestSetId) params.set("requestSetId", String(requestSetId));
  if (modelKey) params.set("modelKey", String(modelKey));
  if (queueType) params.set("queueType", String(queueType));
  return `${inferenceBase}/algo/api/v2/service/ask/queue/status?${params}`;
}

/**
 * Parse a queue-status response. The endpoint answers with a flat object
 * (`{isQueued, serviceAvailable, waitTime, retryAfterSeconds, ...}`), but it is
 * occasionally wrapped, so this reuses the nested-tolerant extractor. Returns
 * null when the body carries no queue signal.
 */
export function parseQoderQueueStatus(body) {
  return parseQoderQueueInfo(body);
}
