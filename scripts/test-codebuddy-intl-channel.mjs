// Live smoke test: the CodeBuddy intl channel-verification gate.
//
// The X-Conversation-* header family is a *server-side* gate that can change
// without any code change here (it was added on 2026-10-15 and broke every
// cbai/* request until the family was sent). Unit tests cannot catch that: they
// mock the gateway. This script talks to the real one and exits non-zero the
// moment the gate rejects a request, so a change is detected before users
// report it.
//
//   CODEBUDDY_INTL_TOKEN=<token> node scripts/test-codebuddy-intl-channel.mjs
//
// Optional:
//   CODEBUDDY_INTL_MODEL   model id to probe       (default: glm-5.2)
//   CODEBUDDY_INTL_HOST    host to probe           (default: www.codebuddy.ai)
//   CODEBUDDY_INTL_PROXY   egress proxy URL        (default: direct)
//
// Exit codes:
//   0  the family is accepted (gate unchanged)
//   1  the gate rejected the family  -> the required headers changed
//   2  the probe could not run (no token, network, unexpected status)
//
// This makes one real, tiny inference call. It spends a fraction of a credit on
// the account whose token is supplied — do not point it at a metered production
// account in a loop.
import { withConversationHeaders } from "../open-sse/executors/codebuddy-intl.js";

const TOKEN = process.env.CODEBUDDY_INTL_TOKEN || "";
const MODEL = process.env.CODEBUDDY_INTL_MODEL || "glm-5.2";
const HOST = process.env.CODEBUDDY_INTL_HOST || "www.codebuddy.ai";
const PROXY = process.env.CODEBUDDY_INTL_PROXY || "";

const URL_ = `https://${HOST}/v2/chat/completions`;

// The base headers the executor's registry supplies; the family is added by the
// function under test so this probe exercises the same code the router runs.
const BASE_HEADERS = {
  "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
  "X-Product": "SaaS",
  "X-IDE-Type": "CLI",
  "X-IDE-Name": "CLI",
  "Content-Type": "application/json",
  Accept: "text/event-stream",
};

function fail(code, message) {
  console.error(`FAIL: ${message}`);
  process.exit(code);
}

async function main() {
  if (!TOKEN) {
    fail(2, "CODEBUDDY_INTL_TOKEN is not set — nothing to probe with.");
  }

  // The body shape the executor sends: a leading system prompt and user content
  // as a typed block (a bare string is answered 11101/11128).
  const body = {
    model: MODEL,
    stream: true,
    messages: [
      { role: "system", content: "You are CodeBuddy Code." },
      { role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] },
    ],
  };

  const headers = withConversationHeaders({ ...BASE_HEADERS }, URL_, body);
  for (const name of [
    "X-Conversation-ID",
    "X-Conversation-Request-ID",
    "X-Conversation-Message-ID",
  ]) {
    if (!headers[name]) fail(1, `the family is incomplete: ${name} was not set.`);
  }

  const init = {
    method: "POST",
    headers: { ...headers, Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  };
  // undici honours a per-request dispatcher; only used when a proxy is supplied.
  if (PROXY) {
    const { ProxyAgent } = await import("undici");
    init.dispatcher = new ProxyAgent(PROXY);
  }

  let response;
  try {
    response = await fetch(URL_, init);
  } catch (error) {
    fail(2, `could not reach ${HOST}: ${error.name}: ${error.message}`);
  }

  const text = await response.text();

  // 11128 "conversation id missing" is the gate's signature. Match the message,
  // not the code alone: 11128 also carries "first message is not system prompt".
  if (text.includes('"code":11128') && /conversation id missing/i.test(text)) {
    fail(
      1,
      `the gateway rejected the conversation family (11128 "conversation id missing").\n`
        + "The required headers changed upstream — re-measure the family in\n"
        + "open-sse/executors/codebuddy-intl.js against the live gateway.\n"
        + `Upstream body: ${text.slice(0, 400)}`,
    );
  }

  if (!response.ok) {
    // A non-2xx that is not the gate is still a failed probe, not a gate change.
    fail(2, `unexpected HTTP ${response.status} from ${HOST}: ${text.slice(0, 300)}`);
  }

  // The gate is passed when the stream produced at least one data frame. An
  // empty-but-200 body would mean the request was accepted but answered oddly,
  // which is worth reporting but is not a gate failure.
  const frames = text.split("\n").filter((line) => line.startsWith("data:")).length;
  if (frames === 0) {
    fail(2, `HTTP 200 but no SSE frames — accepted, yet the response looks wrong: ${text.slice(0, 200)}`);
  }

  console.log(`OK: ${HOST} accepted the X-Conversation-* family for ${MODEL} (${frames} SSE frames).`);
}

main().catch((error) => fail(2, `unexpected error: ${error.stack || error.message}`));
