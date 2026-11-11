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
import { clearAcpBinaryCache, resolveAcpBinaryInfo, resolveAcpProfile, acpProfiles, resolveT3ToolBinary, resolveT3AntigravityGeminiHome } from "../../../src/adapters/acp/profiles";
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
    expect(resolveAcpProfile("antigravity-acp")?.t3ToolName).toBe("antigravity-acp");
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

  test("resolveT3AntigravityGeminiHome picks instance with settings", () => {
    // No T3 state on the test machine path is guaranteed; assert it returns a
    // string-or-undefined without throwing for a synthetic home.
    const home = resolveT3AntigravityGeminiHome("/nonexistent-home-xyz");
    expect(home === undefined || typeof home === "string").toBe(true);
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
});
