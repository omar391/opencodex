/**
 * Generic ACP adapter: one agent session per turn over stdio.
 *
 * The client harness (system prompt, tool catalog, developer context) is NOT
 * forwarded — the ACP agent runs its own harness and answers the user's
 * request. Codex retains no tool ownership here: the agent executes its own
 * tools and its tool activity is progress narration, not client calls.
 */
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../base";
import type { AdapterFactoryContext } from "../registry";
import { resolveAcpBinary, resolveAcpProfile } from "./profiles";
import { runAcpTurn, type AcpTurnDeps } from "./turn";

export type AcpAdapterDeps = AcpTurnDeps;

const ACP_CWD_ENV = "OPENCODEX_ACP_CWD";

function sessionCwd(parsed: OcxParsedRequest): string {
  const override = process.env[ACP_CWD_ENV]?.trim();
  if (override) return override;
  // Codex carries its working directory in <environment_context>; prefer it so
  // the agent edits the directory the user is actually in.
  for (const message of parsed.context.messages) {
    const parts = Array.isArray(message.content) ? message.content : null;
    const text = typeof message.content === "string"
      ? message.content
      : parts?.map(p => (p.type === "text" ? p.text : "")).join("\n") ?? "";
    const match = /<cwd>\s*([^<]+?)\s*<\/cwd>/.exec(text) ?? /cwd[=:]\s*(\/[^\s<]+)/.exec(text);
    if (match?.[1]) return match[1];
  }
  return process.cwd();
}

export function createAcpAdapter(provider: OcxProviderConfig, context: AdapterFactoryContext = {}, deps: AcpAdapterDeps = {}): ProviderAdapter {
  const profile = resolveAcpProfile(context.providerId);
  return {
    name: "acp",

    buildRequest(): AdapterRequest {
      return { url: profile?.canonicalBaseUrl ?? provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "ACP adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void): Promise<void> {
      if (!profile) {
        emit({
          type: "error",
          message: `No ACP agent profile is registered for provider "${context.providerId ?? provider.adapter}".`,
          status: 400,
          errorType: "invalid_request_error",
          code: "unknown_acp_profile",
          retryable: false,
        });
        return;
      }
      const binary = resolveAcpBinary(profile, deps.which);
      if (!binary) {
        emit({
          type: "error",
          message: `${profile.label} CLI not found on PATH. Install it with: ${profile.installHint}`,
          status: 500,
          errorType: "upstream_error",
          code: "cli_not_found",
          retryable: false,
        });
        return;
      }
      await runAcpTurn({
        profile,
        binary,
        provider,
        parsed,
        incoming,
        emit,
        cwd: sessionCwd(parsed),
        deps,
      });
    },
  };
}
