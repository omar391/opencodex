/**
 * Live model discovery for ACP agent profiles: spawn the agent CLI, run the
 * initialize -> session/new handshake, and read the session's advertised
 * `configOptions` model select. Agents that expose their catalog this way
 * (opencode's `configOptions` model options, for example) give the proxy the
 * same roster the agent itself would accept — no static seed to drift.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandInvocation } from "../../lib/win-exec";
import { baseScopedEnv } from "../coding-agent/turn";
import type { WhichFn } from "../coding-agent/profile";
import {
  ACP_INITIALIZE_ID,
  ACP_SESSION_ID,
  MAX_ACP_LINE_BYTES,
  initializeFrame,
  sessionNewFrame,
} from "./protocol";
import { resolveAcpBinaryInfo, type AcpProviderProfile } from "./profiles";
import type { OcxProviderConfig } from "../../types";

const DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;

export interface AcpDiscoveredModel {
  id: string;
  name?: string;
}

export type AcpModelDiscovery =
  | { ok: true; models: AcpDiscoveredModel[]; currentModelId?: string }
  | { ok: false; error: string };

export type AcpDiscoverySpawn = (
  binary: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => ChildProcessWithoutNullStreams;

interface ConfigOptionModel {
  value?: unknown;
  name?: unknown;
}

function modelOptionsFromConfigOptions(configOptions: unknown): { models: AcpDiscoveredModel[]; currentModelId?: string } | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const option of configOptions as Array<Record<string, unknown>>) {
    const category = option?.category;
    const id = option?.id;
    // The model select is identified by the profile's config id; fall back to
    // the "model" category agents use when the id differs.
    if (id !== "model" && category !== "model") continue;
    const options = option.options;
    if (!Array.isArray(options)) continue;
    const models: AcpDiscoveredModel[] = [];
    const seen = new Set<string>();
    for (const entry of options as ConfigOptionModel[]) {
      const value = typeof entry?.value === "string" ? entry.value.trim() : "";
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      models.push(name ? { id: value, name } : { id: value });
    }
    const current = typeof option.currentValue === "string" ? option.currentValue : undefined;
    return { models, ...(current ? { currentModelId: current } : {}) };
  }
  return undefined;
}

/**
 * Spawn the agent and harvest its advertised model select. Returns the agent's
 * own ids verbatim — the turn path sends them back through the same
 * `set_config_option` channel, so discovery and selection cannot disagree.
 */
export async function discoverAcpAgentModels(input: {
  profile: AcpProviderProfile;
  provider: OcxProviderConfig;
  cwd?: string;
  timeoutMs?: number;
  which?: WhichFn;
  spawn?: AcpDiscoverySpawn;
}): Promise<AcpModelDiscovery> {
  const { profile, provider } = input;
  const resolution = resolveAcpBinaryInfo(profile, input.which, { configuredPath: provider.acpBinaryPath });
  if (!resolution) return { ok: false, error: `${profile.label}: agent binary not found` };

  const cwd = input.cwd ?? tmpdir();
  const env = { ...baseScopedEnv(), ...(profile.buildEnv?.(provider.apiKey ?? "", resolution.path) ?? {}) };
  const spawnChild: AcpDiscoverySpawn = input.spawn ?? ((b, args, options) => {
    const inv = commandInvocation(b, args, process.platform, { env: options.env });
    return spawn(inv.file, inv.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
      cwd: options.cwd,
    }) as ChildProcessWithoutNullStreams;
  });

  return await new Promise<AcpModelDiscovery>(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnChild(resolution.path, profile.buildArgs(provider.defaultModel ?? "", resolution.path), { cwd, env });
    } catch (error) {
      resolve({ ok: false, error: `${profile.label}: spawn failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    let buffer = "";
    let total = 0;
    let settled = false;
    const finish = (result: AcpModelDiscovery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 1_500).unref?.();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `${profile.label}: discovery timed out` }), input.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
    timer.unref?.();

    const send = (frame: Record<string, unknown>) => {
      try { child.stdin.write(`${JSON.stringify(frame)}\n`); } catch { /* pipe closed */ }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (settled) return;
      buffer += chunk;
      total += chunk.length;
      if (total > MAX_DISCOVERY_BYTES) return finish({ ok: false, error: `${profile.label}: discovery response too large` });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line || line.length > MAX_ACP_LINE_BYTES) continue;
        let frame: { id?: unknown; result?: { configOptions?: unknown; sessionId?: string }; error?: { message?: string } };
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.id === ACP_INITIALIZE_ID && !frame.error) {
          send(sessionNewFrame(cwd));
          continue;
        }
        if (frame.id === ACP_SESSION_ID) {
          if (frame.error) return finish({ ok: false, error: `${profile.label}: session/new failed: ${frame.error.message ?? "unknown error"}` });
          const found = modelOptionsFromConfigOptions(frame.result?.configOptions);
          if (!found || found.models.length === 0) {
            return finish({ ok: false, error: `${profile.label}: session advertises no model options` });
          }
          return finish({ ok: true, models: found.models, ...(found.currentModelId ? { currentModelId: found.currentModelId } : {}) });
        }
      }
    });
    child.stderr.resume();
    child.on("error", error => finish({ ok: false, error: `${profile.label}: spawn error: ${error.message}` }));
    child.on("exit", () => finish({ ok: false, error: `${profile.label}: agent exited during discovery` }));

    send(initializeFrame("0.0.0-discovery"));
  });
}
