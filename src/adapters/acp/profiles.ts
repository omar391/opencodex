/**
 * Per-agent profiles for the generic ACP adapter.
 *
 * A profile is the only place an ACP agent encodes its launch differences
 * (binary, argv, scoped env, identity URL, permission default). The adapter
 * stays profile-driven so adding an agent is a row plus a profile, not new code.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WhichFn } from "../coding-agent/profile";
import { whichFromPath } from "../coding-agent/profile";

export interface AcpProviderProfile {
  /** Canonical OpenCodex provider id this profile serves (e.g. "devin-acp"). */
  providerId: string;
  /** Human label for diagnostics/error copy (never sent upstream). */
  label: string;
  /** Executable names to resolve on PATH, in preference order. */
  binaryCandidates: readonly string[];
  /**
   * T3 Code managed-tool name under `~/.t3/tools/` (e.g. "antigravity-acp").
   * When set, binary resolution falls back to scanning that folder after PATH
   * so an agent installed through T3 Code's ACP registry is reusable here.
   */
  t3ToolName?: string;
  /** Executable filename inside the T3 tool payload (e.g. "agy_acp_server.par"). */
  t3BinaryName?: string;
  /** ACP session config option id that selects the model (e.g. "model"); unset keeps the agent default. */
  modelConfigId?: string;
  /**
   * Launch arguments for one ACP turn. `modelId` is the resolved wire model;
   * profiles that take a model flag should include it (e.g. ["acp","--model",id]).
   */
  buildArgs: (modelId: string) => string[];
  /** Identity URL recorded as provider.baseUrl; never connected to. */
  canonicalBaseUrl: string;
  /** Install hint surfaced when the binary is missing. */
  installHint: string;
  /** ACP session mode to request on session/new+load (e.g. "ask", "bypass"); unset keeps the agent default. */
  sessionMode?: string;
  /** Env var the profile consumes for a credential; absent means the agent owns its sign-in. */
  tokenEnv?: string;
  /** Extra child-process env layered over the scoped base env. */
  buildEnv?: (apiKey: string) => Record<string, string>;
}

const DEVIN_ACP: AcpProviderProfile = {
  providerId: "devin-acp",
  label: "Devin CLI (ACP agent)",
  binaryCandidates: ["devin", "devin.exe"],
  t3ToolName: "devin",
  t3BinaryName: "devin",
  buildArgs: modelId => ["acp", "--model", modelId],
  canonicalBaseUrl: "https://cli.devin.ai",
  installHint: "Install the Devin CLI with `curl -fsSL https://cli.devin.ai/install.sh | bash` or `brew install --cask devin-cli`, then run `devin auth login`.",
  // Mode unset: the session keeps the agent's own default (accept-edits) and
  // session/request_permission is answered per the operator's allow gate.
  modelConfigId: "model",
};

/**
 * Resolve T3 Code's per-instance GEMINI_HOME for an antigravity-acp provider
 * state dir (`~/.t3/userdata/providers/antigravity/<instance>/` — the parent of
 * the `antigravity-acp/` state the binary reads). Returns undefined when T3 has
 * no antigravity state; the binary then falls back to its own `~/.gemini` home.
 */
export function resolveT3AntigravityGeminiHome(home: string = homedir()): string | undefined {
  const root = join(home, ".t3", "userdata", "providers", "antigravity");
  let instances: string[];
  try {
    instances = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const instance of instances.sort()) {
    const candidate = join(root, instance);
    if (existsSync(join(candidate, "antigravity-acp", "settings.json"))) return candidate;
  }
  return undefined;
}

const ANTIGRAVITY_ACP: AcpProviderProfile = {
  providerId: "antigravity-acp",
  label: "Google Antigravity (ACP agent)",
  // Not a PATH binary: T3 Code's ACP registry installs it under ~/.t3/tools.
  binaryCandidates: [],
  t3ToolName: "antigravity-acp",
  t3BinaryName: "agy_acp_server.par",
  buildArgs: () => [],
  canonicalBaseUrl: "https://antigravity.google",
  installHint: "Install Google Antigravity's ACP server (T3 Code's ACP registry provides `agy_acp_server.par` under ~/.t3/tools), then complete its Google sign-in.",
  modelConfigId: "model",
  buildEnv: () => {
    const env: Record<string, string> = {};
    const geminiHome = resolveT3AntigravityGeminiHome();
    if (geminiHome) env.GEMINI_HOME = geminiHome;
    return env;
  },
};

const PROFILES: readonly AcpProviderProfile[] = [DEVIN_ACP, ANTIGRAVITY_ACP];

const profileById = new Map(PROFILES.map(p => [p.providerId, p]));

/** Resolve the profile for a configured provider id; undefined when unknown. */
export function resolveAcpProfile(providerId: string | undefined): AcpProviderProfile | undefined {
  return providerId ? profileById.get(providerId) : undefined;
}

/** All seeded profiles (provider-registry parity tests iterate this). */
export function acpProfiles(): readonly AcpProviderProfile[] {
  return PROFILES;
}

const binaryCache = new Map<string, string>();

/** Reset the discovery cache (tests). */
export function clearAcpBinaryCache(): void {
  binaryCache.clear();
}

/**
 * Discover the agent binary BEFORE a request is sent, so a missing CLI is a
 * clear pre-flight error rather than a mid-turn ENOENT. Reuses the shared PATH
 * scan so native executables beat batch dispatchers exactly like the
 * coding-agent transports.
 */
export function resolveAcpBinary(
  profile: AcpProviderProfile,
  which: WhichFn = whichFromPath,
  opts?: { home?: string },
): string | undefined {
  const cached = binaryCache.get(profile.providerId);
  if (cached) return cached;
  for (const candidate of profile.binaryCandidates) {
    const resolved = which(candidate);
    if (resolved) {
      binaryCache.set(profile.providerId, resolved);
      return resolved;
    }
  }
  if (profile.t3ToolName && profile.t3BinaryName) {
    const t3 = resolveT3ToolBinary(profile.t3ToolName, profile.t3BinaryName, { home: opts?.home });
    if (t3) {
      binaryCache.set(profile.providerId, t3);
      return t3;
    }
  }
  return undefined;
}

/**
 * Locate a binary inside T3 Code's managed ACP tools tree.
 *
 * Two payload layouts exist in the wild: `<tool>/<platform>/versions/<release>/`
 * (registry binary archives, with `active.json` naming the live release) and
 * `<tool>/<version>/<platform>/bin/` (versioned installs). An `active.json`
 * release wins; otherwise the newest matching executable by mtime is used.
 * `home`/`exists` are seams for tests.
 */
export function resolveT3ToolBinary(
  toolName: string,
  binaryName: string,
  opts?: { home?: string; exists?: (p: string) => boolean },
): string | undefined {
  const home = opts?.home ?? homedir();
  const exists = opts?.exists ?? existsSync;
  const root = join(home, ".t3", "tools", toolName);
  if (!exists(root)) return undefined;

  // Registry layout: <platform>/active.json -> versions/<releaseId>/<binary>
  let platforms: string[] = [];
  try {
    platforms = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const platform of platforms) {
    const activePath = join(root, platform, "active.json");
    if (!exists(activePath)) continue;
    try {
      const active = JSON.parse(readFileSync(activePath, "utf8")) as { releaseId?: string };
      if (active.releaseId) {
        const candidate = join(root, platform, "versions", active.releaseId, binaryName);
        if (exists(candidate)) return candidate;
      }
    } catch { /* unreadable active.json — fall through to the glob scan */ }
  }

  // Versioned layout (and any other): newest executable match wins.
  let best: { path: string; mtime: number } | undefined;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry === binaryName && st.isFile()) {
        if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
      }
    }
  };
  walk(root, 0);
  return best?.path;
}
