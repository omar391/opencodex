/**
 * ACP adapter tests: fake-child protocol driving.
 *
 * The fake child speaks newline-delimited JSON-RPC on real stdio pipes so the
 * turn exercises the same read/write path production uses. Frames are queued
 * per expected request id so the test controls the agent's answers.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAcpAdapter } from "../../../src/adapters/acp/adapter";
import { ACP_INITIALIZE_ID, ACP_PROMPT_ID, ACP_SESSION_ID, buildAcpPrompt, buildAcpHistory, acpUpdateToEvents, mapAcpUsage, sessionLoadFrame, composeEffortModelId } from "../../../src/adapters/acp/protocol";
import { clearAcpBinaryCache, resolveAcpBinaryInfo, resolveAcpProfile, acpProfiles, resolveT3ToolBinary } from "../../../src/adapters/acp/profiles";
import { pooledSessionCount, resetAcpSessionPool } from "../../../src/adapters/acp/session-pool";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

const PROVIDER: OcxProviderConfig = { adapter: "acp", baseUrl: "https://cli.devin.ai", apiKey: "" } as OcxProviderConfig;

function fakeChild(script: (send: (frame: Record<string, unknown>) => void, stdin: PassThrough) => void) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin, stdout, stderr,
    pid: 4242,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: () => { (child as { killed: boolean }).killed = true; return true; },
  }) as unknown as ChildProcessWithoutNullStreams;
  const lines: string[] = [];
  let buf = "";
  stdin.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const send = (frame: Record<string, unknown>) => stdout.write(JSON.stringify(frame) + "\n");
  script(send, stdin);
  return { child, lines, stdin, stdout };
}

function parsed(overrides?: Partial<OcxParsedRequest>): OcxParsedRequest {
  return {
    modelId: "swe-2-high",
    context: {
      systemPrompt: ["CODEX HARNESS — must not be forwarded"],
      messages: [
        { role: "user", content: "earlier question", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "earlier answer" }], timestamp: 2 },
        { role: "user", content: "do the thing", timestamp: 3 },
      ],
      tools: [{ name: "shell" } as never],
    },
    stream: true,
    options: {},
    ...overrides,
  } as OcxParsedRequest;
}

function incoming() {
  return { headers: new Headers(), translatorBudget: undefined as never, abortSignal: undefined } as never;
}

async function collect(adapter: ReturnType<typeof createAcpAdapter>, p: OcxParsedRequest) {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(p, incoming(), e => events.push(e));
  return events;
}

function happyScript(send: (f: Record<string, unknown>) => void, stdin: PassThrough) {
  stdin.on("data", (d: Buffer) => {
    const s = d.toString();
    if (s.includes(`"id":${ACP_INITIALIZE_ID}`)) {
      send({ jsonrpc: "2.0", id: ACP_INITIALIZE_ID, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (s.includes(`"id":${ACP_SESSION_ID}`)) {
      send({ jsonrpc: "2.0", id: ACP_SESSION_ID, result: { sessionId: "sess-1", modes: { currentModeId: "accept-edits" } } });
    } else if (s.includes(`"id":${ACP_PROMPT_ID}`)) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OCX-PROBE-OK" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call", title: "read file", status: "in_progress" } } });
      send({ jsonrpc: "2.0", id: ACP_PROMPT_ID, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 5, cachedReadTokens: 40, totalTokens: 105 } } });
    }
  });
}

describe("acp protocol", () => {
  test("buildAcpPrompt sends only the last user message", () => {
    const blocks = buildAcpPrompt(parsed().context);
    expect(blocks).toEqual([{ type: "text", text: "do the thing" }]);
  });

  test("buildAcpHistory excludes system, developer and tools", () => {
    const history = buildAcpHistory(parsed().context, 2);
    expect(history).toContain("earlier question");
    expect(history).toContain("earlier answer");
    expect(history).not.toContain("CODEX HARNESS");
  });

  test("buildAcpHistory relabels project instructions, drops Codex global harness", () => {
    const ctx = parsed().context;
    ctx.messages.unshift(
      { role: "user", content: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nload every codex skill\n</INSTRUCTIONS>", timestamp: 0 } as never,
      { role: "user", content: "# AGENTS.md instructions for /repo/app\n\n<INSTRUCTIONS>\nrepo rules for agents\n</INSTRUCTIONS>", timestamp: 0 } as never,
      { role: "user", content: "<environment_context><cwd>/tmp/x</cwd></environment_context>", timestamp: 0 } as never,
    );
    const history = buildAcpHistory(ctx, 5);
    // Project + environment context delivered once, labeled — not user speech.
    expect(history).toContain("[Client instructions]");
    expect(history).toContain("repo rules for agents");
    expect(history).toContain("environment_context");
    // Codex's global harness file (~/.codex/AGENTS.md) never reaches the agent.
    expect(history).not.toContain("load every codex skill");
    const clientSection = history.slice(0, history.indexOf("[User]"));
    expect(clientSection).not.toContain("[User]");
    expect(history).toContain("earlier question");
  });

  test("acpUpdateToEvents maps chunks and tool progress", () => {
    expect(acpUpdateToEvents({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } })).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(acpUpdateToEvents({ sessionUpdate: "agent_thought_chunk", content: { text: "hmm" } })).toEqual([{ type: "thinking_delta", thinking: "hmm" }]);
    const tool = acpUpdateToEvents({ sessionUpdate: "tool_call", title: "ls", status: "in_progress" });
    expect(tool[0]!.type).toBe("thinking_delta");
    expect(acpUpdateToEvents({ sessionUpdate: "user_message_chunk", content: { text: "replay" } })).toEqual([]);
  });

  test("mapAcpUsage keeps cached read tokens", () => {
    const u = mapAcpUsage({ inputTokens: 100, outputTokens: 5, cachedReadTokens: 40, totalTokens: 105 });
    expect(u).toMatchObject({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 40 });
  });

  test("composeEffortModelId composes rungs and honors noSuffix", () => {
    const suffix = { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", noSuffix: ["adaptive"] };
    expect(composeEffortModelId("swe-2-flash", "high", suffix)).toBe("swe-2-flash-high");
    expect(composeEffortModelId("swe-2-flash", undefined, suffix)).toBe("swe-2-flash-medium");
    expect(composeEffortModelId("swe-2-flash", "bogus", suffix)).toBe("swe-2-flash-medium");
    expect(composeEffortModelId("adaptive", "high", suffix)).toBe("adaptive");
    expect(composeEffortModelId("swe-2-high", "low", suffix)).toBe("swe-2-high");
  });

  test("resolveAcpBinaryInfo reports config > env > path precedence and source", () => {
    clearAcpBinaryCache();
    const profile = resolveAcpProfile("devin-acp")!;
    delete process.env.OPENCODEX_ACP_DEVIN_BIN;
    // Configured path wins over env and scans, is trimmed, and is not cached.
    expect(resolveAcpBinaryInfo(profile, () => "/scan/devin", { configuredPath: "  /custom/devin  " }))
      .toEqual({ path: "/custom/devin", source: "config" });
    process.env.OPENCODEX_ACP_DEVIN_BIN = "/env/devin";
    expect(resolveAcpBinaryInfo(profile, () => "/scan/devin")).toEqual({ path: "/env/devin", source: "env" });
    delete process.env.OPENCODEX_ACP_DEVIN_BIN;
    clearAcpBinaryCache();
    expect(resolveAcpBinaryInfo(profile, () => "/scan/devin")).toEqual({ path: "/scan/devin", source: "path" });
    // A configured path set after a cached scan still wins — settings edits apply live.
    expect(resolveAcpBinaryInfo(profile, () => "/scan/devin", { configuredPath: "/later/devin" }))
      .toEqual({ path: "/later/devin", source: "config" });
  });

  test("sessionLoadFrame targets an existing session", () => {
    expect(sessionLoadFrame("abc", "/tmp")).toMatchObject({ method: "session/load", params: { sessionId: "abc", cwd: "/tmp" } });
  });

  test("profiles resolve by provider id", () => {
    expect(resolveAcpProfile("devin-acp")?.binaryCandidates).toContain("devin");
    expect(resolveAcpProfile("antigravity-acp")?.binaryCandidates).toContain("agy");
    expect(resolveAcpProfile("opencode-acp")?.binaryCandidates).toContain("opencode");
    expect(resolveAcpProfile("opencode-acp")?.buildArgs("opencode/big-pickle")).toEqual(["acp"]);
    expect(resolveAcpProfile("antigravity-acp")?.t3ToolName).toBeUndefined();
    expect(resolveAcpProfile("nope")).toBeUndefined();
    expect(acpProfiles().length).toBeGreaterThan(0);
  });

  test("resolveT3ToolBinary resolves registry active.json and versioned layouts", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-t3tools-"));
    // Registry layout: <tool>/<platform>/active.json -> versions/<release>/<bin>
    const relDir = join(root, ".t3", "tools", "agy", "darwin-arm64");
    mkdirSync(join(relDir, "versions", "relA"), { recursive: true });
    mkdirSync(join(relDir, "versions", "relB"), { recursive: true });
    writeFileSync(join(relDir, "active.json"), JSON.stringify({ releaseId: "relB" }));
    writeFileSync(join(relDir, "versions", "relA", "agy_acp_server.par"), "x");
    writeFileSync(join(relDir, "versions", "relB", "agy_acp_server.par"), "x");
    expect(resolveT3ToolBinary("agy", "agy_acp_server.par", { home: root }))
      .toBe(join(relDir, "versions", "relB", "agy_acp_server.par"));
    // Versioned layout fallback (no active.json): newest match wins.
    const vDir = join(root, ".t3", "tools", "dev", "1.0.0", "darwin-aarch64", "bin");
    mkdirSync(vDir, { recursive: true });
    writeFileSync(join(vDir, "devin"), "x");
    expect(resolveT3ToolBinary("dev", "devin", { home: root })).toBe(join(vDir, "devin"));
    expect(resolveT3ToolBinary("missing", "devin", { home: root })).toBeUndefined();
  });

});

describe("acp adapter runTurn", () => {
  test("streams a full turn and emits done with providerState", async () => {
    clearAcpBinaryCache();
    const { child } = fakeChild(happyScript);
    const adapter = createAcpAdapter(PROVIDER, { providerId: "devin-acp" }, {
      spawn: (() => child) as never,
      which: (() => "/fake/devin") as never,
      timeoutMs: 5_000,
      killGraceMs: 10,
      reapTimeoutMs: 20,
    });
    const events = await collect(adapter, parsed());
    const done = events.find(e => e.type === "done") as Extract<AdapterEvent, { type: "done" }> | undefined;
    expect(done).toBeDefined();
    expect(done?.providerState?.acp).toMatchObject({ sessionId: "sess-1", modelId: "swe-2-high" });
    expect(done?.usage).toMatchObject({ inputTokens: 100, outputTokens: 5 });
    expect(events.some(e => e.type === "text_delta" && (e as { text?: string }).text === "OCX-PROBE-OK")).toBe(true);
  });

  test("rejected model surfaces the agent error and never prompts", async () => {
    clearAcpBinaryCache();
    const rejectScript = (send: (f: Record<string, unknown>) => void, stdin: PassThrough) => {
      stdin.on("data", (d: Buffer) => {
        const s = d.toString();
        if (s.includes(`"id":${ACP_INITIALIZE_ID}`)) {
          send({ jsonrpc: "2.0", id: ACP_INITIALIZE_ID, result: { protocolVersion: 1 } });
        } else if (s.includes(`"id":${ACP_SESSION_ID}`)) {
          send({ jsonrpc: "2.0", id: ACP_SESSION_ID, result: { sessionId: "sess-1", configOptions: [{ id: "model", options: [{ value: "gemini-3.8-flash" }] }] } });
        } else if (s.includes('"id":5,')) {
          send({ jsonrpc: "2.0", id: 5, error: { code: -32602, message: "Model 'swe-2-high' is not available for the current authentication method.", data: { availableModels: ["gemini-3.8-flash-high", "gemini-3.8-flash-low"] } } });
        } else if (s.includes(`"id":${ACP_PROMPT_ID}`)) {
          send({ jsonrpc: "2.0", id: ACP_PROMPT_ID, result: { stopReason: "end_turn" } });
        }
      });
    };
    const { child } = fakeChild(rejectScript);
    const adapter = createAcpAdapter(PROVIDER, { providerId: "devin-acp" }, {
      spawn: (() => child) as never,
      which: (() => "/fake/devin") as never,
      timeoutMs: 5_000,
      killGraceMs: 10,
      reapTimeoutMs: 20,
    });
    const events = await collect(adapter, parsed());
    const err = events.find(e => e.type === "error") as Extract<AdapterEvent, { type: "error" }> | undefined;
    expect(err?.code).toBe("acp_model_rejected");
    expect(err?.message).toContain("not available for the current authentication method");
    expect(err?.message).toContain("gemini-3.8-flash-high");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("quota notice becomes a failover error without leaking text", async () => {
    clearAcpBinaryCache();
    const QUOTA = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 37h48m0s.";
    const quotaScript = (send: (f: Record<string, unknown>) => void, stdin: PassThrough) => {
      stdin.on("data", (d: Buffer) => {
        const s = d.toString();
        if (s.includes(`"id":${ACP_INITIALIZE_ID}`)) {
          send({ jsonrpc: "2.0", id: ACP_INITIALIZE_ID, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        } else if (s.includes(`"id":${ACP_SESSION_ID}`)) {
          send({ jsonrpc: "2.0", id: ACP_SESSION_ID, result: { sessionId: "sess-quota" } });
        } else if (s.includes(`"id":${ACP_PROMPT_ID}`)) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-quota", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: QUOTA.slice(0, 40) } } } });
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-quota", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: QUOTA.slice(40) } } } });
          send({ jsonrpc: "2.0", id: ACP_PROMPT_ID, result: { stopReason: "end_turn" } });
        }
      });
    };
    const { child } = fakeChild(quotaScript);
    const adapter = createAcpAdapter(PROVIDER, { providerId: "devin-acp" }, {
      spawn: (() => child) as never,
      which: (() => "/fake/devin") as never,
      timeoutMs: 5_000,
      killGraceMs: 10,
      reapTimeoutMs: 20,
    });
    const events = await collect(adapter, parsed());
    const err = events.find(e => e.type === "error") as Extract<AdapterEvent, { type: "error" }> | undefined;
    expect(err).toMatchObject({ code: "acp_quota_exhausted", status: 429, errorType: "rate_limit_error", retryable: true });
    // The held notice must be discarded, not flushed ahead of the error event —
    // a leaked text_delta commits the stream and combo failover never engages.
    expect(events.some(e => e.type === "text_delta")).toBe(false);
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("unknown provider id fails closed", async () => {
    const adapter = createAcpAdapter(PROVIDER, { providerId: "unknown-agent" });
    const events = await collect(adapter, parsed());
    expect(events[0]).toMatchObject({ type: "error", code: "unknown_acp_profile" });
  });

  test("missing binary fails before spawn", async () => {
    clearAcpBinaryCache();
    const adapter = createAcpAdapter(PROVIDER, { providerId: "devin-acp" }, { which: (() => undefined) as never, homeDir: "/nonexistent-ocx-home" });
    const events = await collect(adapter, parsed());
    expect(events[0]).toMatchObject({ type: "error", code: "cli_not_found" });
  });

  test("second turn reuses the pooled session without respawning", async () => {
    resetAcpSessionPool();
    clearAcpBinaryCache();
    const warmScript = (send: (f: Record<string, unknown>) => void, stdin: PassThrough) => {
      stdin.on("data", (d: Buffer) => {
        const s = d.toString();
        // Ids are comma-terminated: '"id":100' would otherwise match '"id":1'.
        if (s.includes('"id":1,')) {
          send({ jsonrpc: "2.0", id: ACP_INITIALIZE_ID, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        } else if (s.includes('"id":2,')) {
          send({ jsonrpc: "2.0", id: ACP_SESSION_ID, result: { sessionId: "sess-warm", modes: { currentModeId: "accept-edits" } } });
        } else if (s.includes('"method":"session/prompt"')) {
          // Cold path prompt id is 3; pooled turns assign ids from 100 upward.
          const id = Number(/"id":(\d+)/.exec(s)?.[1] ?? ACP_PROMPT_ID);
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-warm", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "WARM-OK" } } } });
          send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
        }
      });
    };
    let spawns = 0;
    const { child, lines } = fakeChild(warmScript);
    const adapter = createAcpAdapter(PROVIDER, { providerId: "devin-acp" }, {
      spawn: (() => { spawns += 1; return child; }) as never,
      which: (() => "/fake/devin") as never,
      timeoutMs: 5_000,
      killGraceMs: 10,
      reapTimeoutMs: 20,
      sessionPool: true,
    });

    const first = await collect(adapter, parsed({ _codexOwnThreadId: "thr-1" }));
    const done1 = first.find(e => e.type === "done") as Extract<AdapterEvent, { type: "done" }> | undefined;
    expect(done1?.providerState?.acp?.sessionId).toBe("sess-warm");
    expect(spawns).toBe(1);
    // Adoption keeps the agent alive — no kill, one pooled session.
    expect((child as unknown as { killed: boolean }).killed).toBe(false);
    expect(pooledSessionCount()).toBe(1);

    const linesAfterFirst = lines.length;
    const secondParsed = parsed({
      context: { ...parsed().context, messages: [{ role: "user", content: "follow up", timestamp: 4 }] },
      _providerContinuation: { acp: { sessionId: "sess-warm", modelId: "swe-2-high" } },
    } as Partial<OcxParsedRequest>);
    const second = await collect(adapter, secondParsed);
    const done2 = second.find(e => e.type === "done") as Extract<AdapterEvent, { type: "done" }> | undefined;
    expect(done2).toBeDefined();
    expect(done2?.providerState?.acp?.sessionId).toBe("sess-warm");
    expect(second.some(e => e.type === "text_delta" && (e as { text?: string }).text === "WARM-OK")).toBe(true);

    // Warm turn sent only prompt frames — no initialize/session handshake, no respawn.
    expect(spawns).toBe(1);
    const warmLines = lines.slice(linesAfterFirst).join("\n");
    expect(warmLines).not.toContain('"method":"initialize"');
    expect(warmLines).not.toContain('"method":"session/new"');
    expect(warmLines).not.toContain('"method":"session/load"');
    expect(warmLines).toContain('"method":"session/prompt"');

    // Codex store:false shape: no continuation state, only the thread id —
    // the pool's thread alias must still find the warm session.
    const linesAfterSecond = lines.length;
    const third = await collect(adapter, parsed({ _codexOwnThreadId: "thr-1" }));
    expect(third.some(e => e.type === "done")).toBe(true);
    expect(spawns).toBe(1);
    const thirdLines = lines.slice(linesAfterSecond).join("\n");
    expect(thirdLines).not.toContain('"method":"initialize"');
    expect(thirdLines).toContain('"method":"session/prompt"');
    resetAcpSessionPool();
  });
});
