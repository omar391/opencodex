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
   * Env var naming an explicit binary path override (checked before PATH and
   * T3 scans). This is the operator customization seam until the dashboard
   * exposes a per-provider binary field.
   */
  binEnv?: string;
  /**
   * Effort-suffix composition for agents whose model catalog spells effort
   * into the model id (`swe-2-flash` + `medium` → `swe-2-flash-medium`).
   * `models` then lists BASE ids and the provider row carries reasoningEfforts;
   * the adapter composes the wire id. `noSuffix` names ids passed verbatim
   * (routers/variants that take no effort rung).
   */
  effortSuffix?: {
    efforts: readonly string[];
    separator?: string;
    defaultEffort?: string;
    noSuffix?: readonly string[];
  };
  /**
   * Launch arguments for one ACP turn. `modelId` is the resolved wire model;
   * profiles that take a model flag should include it (e.g. ["acp","--model",id]).
   */
  buildArgs: (modelId: string, binaryPath: string) => string[];
  /** Identity URL recorded as provider.baseUrl; never connected to. */
  canonicalBaseUrl: string;
  /** Install hint surfaced when the binary is missing. */
  installHint: string;
  /** ACP session mode to request on session/new+load (e.g. "ask", "bypass"); unset keeps the agent default. */
  sessionMode?: string;
  /** Env var the profile consumes for a credential; absent means the agent owns its sign-in. */
  tokenEnv?: string;
  /** Extra child-process env layered over the scoped base env. */
  buildEnv?: (apiKey: string, binaryPath: string) => Record<string, string>;
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
  binEnv: "OPENCODEX_ACP_DEVIN_BIN",
  effortSuffix: {
    // Cognition's catalog rungs; `adaptive` is the auto-router and takes none.
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    noSuffix: ["adaptive"],
  },
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
  // `agy` on PATH is the Antigravity CLI whose `acp` subcommand serves the full
  // model catalog (Claude/GPT/Gemini) under the CLI's own sign-in. T3 Code's
  // managed `agy_acp_server.par` is the narrower fallback — it exposes only
  // Gemini models under oauth-personal.
  binaryCandidates: ["agy"],
  t3ToolName: "antigravity-acp",
  t3BinaryName: "agy_acp_server.par",
  buildArgs: (_modelId, binaryPath) => binaryPath.endsWith("/agy") || binaryPath === "agy" ? ["acp"] : [],
  canonicalBaseUrl: "https://antigravity.google",
  installHint: "Install Google Antigravity (`agy` CLI or T3 Code's ACP registry `agy_acp_server.par` under ~/.t3/tools), then complete its Google sign-in.",
  modelConfigId: "model",
  binEnv: "OPENCODEX_ACP_ANTIGRAVITY_BIN",
  buildEnv: (_apiKey, binaryPath) => {
    // GEMINI_HOME only applies to the .par server; the agy CLI keeps its own
    // app-data dir (~/.gemini/antigravity-cli) and auth.
    if (!(binaryPath.endsWith(".par") || binaryPath.includes("agy_acp_server"))) return {};
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

export type AcpBinarySource = "config" | "env" | "path" | "t3";

export interface AcpBinaryResolution {
  path: string;
  source: AcpBinarySource;
}

const binaryInfoCache = new Map<string, AcpBinaryResolution>();

/** Reset the discovery cache (tests). */
export function clearAcpBinaryCache(): void {
  binaryInfoCache.clear();
}

/**
 * Discover the agent binary BEFORE a request is sent, so a missing CLI is a
 * clear pre-flight error rather than a mid-turn ENOENT. Resolution order:
 * provider config `acpBinaryPath` > profile env override > PATH candidates >
 * T3 Code's managed tools tree (when present). The configured path is answered
 * before the cache so a settings edit takes effect without a restart; scan
 * results are cached per profile because env/PATH/T3 do not move mid-process.
 * Reuses the shared PATH scan so native executables beat batch dispatchers
 * exactly like the coding-agent transports.
 */
export function resolveAcpBinaryInfo(
  profile: AcpProviderProfile,
  which: WhichFn = whichFromPath,
  opts?: { home?: string; configuredPath?: string },
): AcpBinaryResolution | undefined {
  const configured = opts?.configuredPath?.trim();
  if (configured) return { path: configured, source: "config" };
  const cached = binaryInfoCache.get(profile.providerId);
  if (cached) return cached;
  const remember = (path: string, source: AcpBinarySource): AcpBinaryResolution => {
    const resolution = { path, source };
    binaryInfoCache.set(profile.providerId, resolution);
    return resolution;
  };
  // Explicit operator override wins over every scan target.
  const override = profile.binEnv ? process.env[profile.binEnv]?.trim() : undefined;
  if (override) return remember(override, "env");
  for (const candidate of profile.binaryCandidates) {
    const resolved = which(candidate);
    if (resolved) return remember(resolved, "path");
  }
  if (profile.t3ToolName && profile.t3BinaryName) {
    const t3 = resolveT3ToolBinary(profile.t3ToolName, profile.t3BinaryName, { home: opts?.home });
    if (t3) return remember(t3, "t3");
  }
  return undefined;
}

export function resolveAcpBinary(
  profile: AcpProviderProfile,
  which: WhichFn = whichFromPath,
  opts?: { home?: string; configuredPath?: string },
): string | undefined {
  return resolveAcpBinaryInfo(profile, which, opts)?.path;
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
