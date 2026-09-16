import { describe, it, expect } from "vitest";

import {
  CAMBER_DEFAULT_AGENT,
  CAMBER_DEFAULT_MODEL,
  buildCamberChatBody,
  buildCamberContent,
  camberModelIdFromWire,
  decodeCamberFrame,
  decodeCamberFrames,
  normalizeCamberUsage,
  resolveCamberAgent,
  resolveCamberEffort,
  resolveCamberModel,
} from "../../open-sse/shared/camberAuth.js";

// The frames below are verbatim from a live POST /api/cli/chat capture (see the
// header of open-sse/shared/camberAuth.js for how it was taken). They are the
// contract: if Camber changes the protocol, these are the first things to break.
describe("decodeCamberFrame — AI SDK v4 data-stream prefixes", () => {
  it("decodes a text delta", () => {
    expect(decodeCamberFrame('0:"OK"')).toEqual({ type: "text", text: "OK" });
  });

  it("decodes the start-step frame", () => {
    expect(decodeCamberFrame('f:{"messageId": "13907496-52b0-4d77-a807-646d48814bbe"}')).toEqual({
      type: "message",
      messageId: "13907496-52b0-4d77-a807-646d48814bbe",
    });
  });

  it("decodes the finish frame and keeps the real token usage", () => {
    const event = decodeCamberFrame(
      'd:{"finishReason": "stop", "usage": {"promptTokens": 1134, "completionTokens": 4}}',
    );
    expect(event.type).toBe("finish");
    expect(event.finishReason).toBe("stop");
    expect(event.usage).toEqual({
      prompt_tokens: 1134,
      completion_tokens: 4,
      total_tokens: 1138,
    });
  });

  it("decodes the finish-step frame", () => {
    const event = decodeCamberFrame(
      'e:{"finishReason": "tool-calls", "usage": {"promptTokens": null, "completionTokens": null}, "isContinued": false}',
    );
    expect(event).toEqual({ type: "step", finishReason: "tool-calls" });
  });

  it("treats the custom z: frame as the end marker", () => {
    expect(decodeCamberFrame("z:[]")).toEqual({ type: "end" });
  });

  it("drops tool frames — this provider is a text surface", () => {
    expect(
      decodeCamberFrame(
        '9:{"toolCallId": "jupyter_start_server_1", "toolName": "jupyter_start_server", "args": {}}',
      ),
    ).toBeNull();
    expect(
      decodeCamberFrame('a:{"toolCallId": "x", "result": {"is_jupyter_server_running": false}}'),
    ).toBeNull();
    expect(decodeCamberFrame('b:{"toolCallId": "x", "toolName": "agent_orchestrator_tool"}')).toBeNull();
  });

  it("decodes an error frame", () => {
    expect(decodeCamberFrame('3:"model unavailable"')).toEqual({
      type: "error",
      message: "model unavailable",
    });
  });

  it("ignores blank frames (the server emits many) and unknown lines", () => {
    expect(decodeCamberFrame("")).toBeNull();
    expect(decodeCamberFrame("   ")).toBeNull();
    expect(decodeCamberFrame("hello world")).toBeNull();
    // A prefix we do not know is not a frame.
    expect(decodeCamberFrame('q:{"a":1}')).toBeNull();
  });

  it("tolerates CRLF line endings", () => {
    expect(decodeCamberFrame('0:"hi"\r')).toEqual({ type: "text", text: "hi" });
  });
});

describe("decodeCamberFrames — buffering", () => {
  it("returns only complete lines and hands back the partial tail", () => {
    const { events, rest } = decodeCamberFrames('0:"a"\n0:"b"\nf:{"mess');
    expect(events).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    // The half-written frame must survive to the next chunk instead of being
    // dropped or mis-parsed.
    expect(rest).toBe('f:{"mess');
  });

  it("decodes nothing from a buffer without a newline", () => {
    const { events, rest } = decodeCamberFrames('0:"partial"');
    expect(events).toEqual([]);
    expect(rest).toBe('0:"partial"');
  });

  it("skips empty chunks interleaved with real frames", () => {
    const { events } = decodeCamberFrames('\n\n\n0:"x"\n\n');
    expect(events).toEqual([{ type: "text", text: "x" }]);
  });
});

describe("normalizeCamberUsage", () => {
  it("returns null when the server reports nothing (tool-only turn)", () => {
    expect(normalizeCamberUsage({ promptTokens: null, completionTokens: null })).toBeNull();
    expect(normalizeCamberUsage(null)).toBeNull();
  });

  it("accepts snake_case as well as camelCase", () => {
    expect(normalizeCamberUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("derives the total and never returns a negative count", () => {
    expect(normalizeCamberUsage({ promptTokens: 2, completionTokens: 3 }).total_tokens).toBe(5);
    expect(normalizeCamberUsage({ promptTokens: -5, completionTokens: 3 })).toEqual({
      prompt_tokens: 0,
      completion_tokens: 3,
      total_tokens: 3,
    });
  });
});

describe("resolveCamberEffort", () => {
  it("maps the three values the server accepts", () => {
    for (const level of ["low", "medium", "high"]) {
      expect(resolveCamberEffort(level)).toEqual({ effort: level, thinkingEnabled: true });
    }
  });

  it("turns reasoning OFF instead of inventing an effort value", () => {
    // The CLI's own --effort vocabulary is low/medium/high; the server's oneof
    // rejects "none", so the honest translation is thinking_enabled:false.
    expect(resolveCamberEffort("none")).toEqual({ effort: null, thinkingEnabled: false });
    expect(resolveCamberEffort("minimal")).toEqual({ effort: null, thinkingEnabled: false });
  });

  it("clamps xhigh to high (the highest tier Camber has)", () => {
    expect(resolveCamberEffort("xhigh")).toEqual({ effort: "high", thinkingEnabled: true });
  });

  it("sends neither field when no intent was expressed", () => {
    expect(resolveCamberEffort(undefined)).toEqual({ effort: null, thinkingEnabled: null });
    expect(resolveCamberEffort("auto")).toEqual({ effort: null, thinkingEnabled: null });
  });

  it("never emits a value outside the accepted set", () => {
    for (const value of ["bogus", "ultra", "0", ""]) {
      const { effort } = resolveCamberEffort(value);
      expect(effort === null || ["low", "medium", "high"].includes(effort)).toBe(true);
    }
  });
});

describe("resolveCamberModel", () => {
  it("maps a registry id to the bedrock-qualified wire name", () => {
    expect(resolveCamberModel("claude-opus-5")).toBe("bedrock:claude-opus-5");
    expect(resolveCamberModel("claude-sonnet-5")).toBe("bedrock:claude-sonnet-5");
  });

  it("maps claude-opus-4-6 onto the -v1 wire id", () => {
    expect(resolveCamberModel("claude-opus-4-6")).toBe("bedrock:claude-opus-4-6-v1");
  });

  it("passes an already-qualified id through", () => {
    expect(resolveCamberModel("bedrock:claude-opus-5")).toBe("bedrock:claude-opus-5");
  });

  it("keeps an unknown model routable rather than dropping it", () => {
    // Camber has no catalog endpoint, so a model it adds later must still reach
    // the server (which is the only authority on the plan).
    expect(resolveCamberModel("claude-haiku-9")).toBe("bedrock:claude-haiku-9");
  });

  it("falls back to the default for an empty id", () => {
    expect(resolveCamberModel("")).toBe(CAMBER_DEFAULT_MODEL);
    expect(resolveCamberModel(null)).toBe(CAMBER_DEFAULT_MODEL);
  });

  it("round-trips a wire id back to the catalog id", () => {
    expect(camberModelIdFromWire("bedrock:claude-opus-4-6-v1")).toBe("claude-opus-4-6");
    expect(camberModelIdFromWire("bedrock:something-new")).toBe("bedrock:something-new");
  });
});

describe("resolveCamberAgent", () => {
  it("defaults to the platform agent", () => {
    expect(resolveCamberAgent({})).toBe(CAMBER_DEFAULT_AGENT);
    expect(resolveCamberAgent(undefined)).toBe(CAMBER_DEFAULT_AGENT);
  });

  it("strips the leading @ the wire does not take", () => {
    // The CLI sends context_agent WITHOUT the @ (verified on the wire).
    expect(resolveCamberAgent({ camberAgent: "@nova.cli" })).toBe("nova.cli");
    expect(resolveCamberAgent({ camberAgent: "reze.saint_martin_bot" })).toBe("reze.saint_martin_bot");
  });

  it("falls back when the stored value is blank", () => {
    expect(resolveCamberAgent({ camberAgent: "   " })).toBe(CAMBER_DEFAULT_AGENT);
  });
});

describe("buildCamberContent", () => {
  it("flattens an OpenAI message list into one content string", () => {
    const content = buildCamberContent([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    expect(content).toBe("[system]\nbe terse\n\nhi");
  });

  it("labels assistant turns so the history stays readable", () => {
    const content = buildCamberContent([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]);
    expect(content).toBe("hi\n\n[assistant]\nhello\n\nbye");
  });

  it("joins multi-part text content", () => {
    const content = buildCamberContent([
      { role: "user", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] },
    ]);
    expect(content).toBe("part one\npart two");
  });

  it("ignores non-text parts and empty turns", () => {
    const content = buildCamberContent([
      { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
      { role: "user", content: "real" },
      { role: "assistant", content: "" },
    ]);
    expect(content).toBe("real");
  });

  it("survives a missing message list", () => {
    expect(buildCamberContent(undefined)).toBe("");
  });
});

describe("buildCamberChatBody", () => {
  it("sends the minimal body the CLI sends, plus the resolved model", () => {
    const body = buildCamberChatBody({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      providerSpecificData: {},
    });
    expect(body).toEqual({
      context_agent: "nova.cli",
      content: "hi",
      model_name: "bedrock:claude-opus-5",
    });
  });

  it("omits effort/thinking when the caller expressed no intent", () => {
    const body = buildCamberChatBody({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      providerSpecificData: {},
    });
    expect(body).not.toHaveProperty("effort");
    expect(body).not.toHaveProperty("thinking_enabled");
  });

  it("sends effort + thinking_enabled when a level was requested", () => {
    const body = buildCamberChatBody({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      providerSpecificData: {},
      reasoningEffort: "high",
    });
    expect(body.effort).toBe("high");
    expect(body.thinking_enabled).toBe(true);
  });

  it("honours the per-connection agent and reasoning default", () => {
    const body = buildCamberChatBody({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      providerSpecificData: { camberAgent: "@reze.my_agent", reasoningEffort: "low" },
    });
    expect(body.context_agent).toBe("reze.my_agent");
    expect(body.effort).toBe("low");
  });

  it("carries a conversation id and agent version when present", () => {
    const body = buildCamberChatBody({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      providerSpecificData: { camberAgentVersion: "3" },
      conversationId: "5d4a721e-5ddd-4e35-80db-765f91300db8",
    });
    expect(body.conversation_id).toBe("5d4a721e-5ddd-4e35-80db-765f91300db8");
    expect(body.context_agent_version).toBe("3");
  });
});
