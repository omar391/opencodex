import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { discoverAcpAgentModels } from "../../../src/adapters/acp/live-models";
import { clearAcpBinaryCache, resolveAcpProfile } from "../../../src/adapters/acp/profiles";
import type { OcxProviderConfig } from "../../../src/types";

const PROVIDER: OcxProviderConfig = { adapter: "acp", baseUrl: "https://opencode.ai", apiKey: "" } as OcxProviderConfig;
const PROFILE = resolveAcpProfile("opencode-acp")!;

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
  let buf = "";
  stdin.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      script((frame: Record<string, unknown>) => stdout.write(JSON.stringify(frame) + "\n"), line);
    }
  });
  return child;
}

function handshakeThen(result: Record<string, unknown>) {
  return (send: (f: Record<string, unknown>) => void, line: string) => {
    if (line.includes('"id":1,')) send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    else if (line.includes('"id":2,')) send({ jsonrpc: "2.0", id: 2, result });
  };
}

describe("discoverAcpAgentModels", () => {
  test("harvests the session's model configOptions", async () => {
    const child = fakeChild(handshakeThen({
      sessionId: "ses_1",
      configOptions: [{
        id: "model", name: "Model", category: "model", type: "select",
        currentValue: "opencode/big-pickle",
        options: [
          { value: "opencode/big-pickle", name: "opencode/Big Pickle" },
          { value: "opencode/glm-5.3-flash-free", name: "opencode/GLM-5.3-Flash Free" },
          { value: "opencode/big-pickle", name: "duplicate ignored" },
        ],
      }],
    }));
    const live = await discoverAcpAgentModels({
      profile: PROFILE, provider: PROVIDER,
      spawn: (() => child) as never, which: (() => "/fake/opencode") as never,
    });
    expect(live).toEqual({
      ok: true,
      currentModelId: "opencode/big-pickle",
      models: [
        { id: "opencode/big-pickle", name: "opencode/Big Pickle" },
        { id: "opencode/glm-5.3-flash-free", name: "opencode/GLM-5.3-Flash Free" },
      ],
    });
  });

  test("session/new error surfaces the agent's message", async () => {
    const errChild = fakeChild((send, line) => {
      if (line.includes('"id":1,')) send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
      else if (line.includes('"id":2,')) send({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "no session" } });
    });
    const live = await discoverAcpAgentModels({
      profile: PROFILE, provider: PROVIDER,
      spawn: (() => errChild) as never, which: (() => "/fake/opencode") as never,
    });
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.error).toContain("no session");
  });

  test("session without model options fails closed", async () => {
    const child = fakeChild(handshakeThen({ sessionId: "ses_1", configOptions: [] }));
    const live = await discoverAcpAgentModels({
      profile: PROFILE, provider: PROVIDER,
      spawn: (() => child) as never, which: (() => "/fake/opencode") as never,
    });
    expect(live.ok).toBe(false);
  });

  test("missing binary fails before spawn", async () => {
    clearAcpBinaryCache();
    const live = await discoverAcpAgentModels({
      profile: PROFILE, provider: PROVIDER,
      which: (() => undefined) as never,
    });
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.error).toContain("binary not found");
  });
});
