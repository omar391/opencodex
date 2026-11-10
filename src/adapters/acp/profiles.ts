/**
 * Per-agent profiles for the generic ACP adapter.
 *
 * A profile is the only place an ACP agent encodes its launch differences
 * (binary, argv, scoped env, identity URL, permission default). The adapter
 * stays profile-driven so adding an agent is a row plus a profile, not new code.
 */
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
  buildArgs: modelId => ["acp", "--model", modelId],
  canonicalBaseUrl: "https://cli.devin.ai",
  installHint: "Install the Devin CLI with `curl -fsSL https://cli.devin.ai/install.sh | bash` or `brew install --cask devin-cli`, then run `devin auth login`.",
  // Mode unset: the session keeps the agent's own default (accept-edits) and
  // session/request_permission is answered per the operator's allow gate.
};

const PROFILES: readonly AcpProviderProfile[] = [DEVIN_ACP];

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
export function resolveAcpBinary(profile: AcpProviderProfile, which: WhichFn = whichFromPath): string | undefined {
  const cached = binaryCache.get(profile.providerId);
  if (cached) return cached;
  for (const candidate of profile.binaryCandidates) {
    const resolved = which(candidate);
    if (resolved) {
      binaryCache.set(profile.providerId, resolved);
      return resolved;
    }
  }
  return undefined;
}
