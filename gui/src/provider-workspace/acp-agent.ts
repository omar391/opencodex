/**
 * provider-workspace/acp-agent.ts
 *
 * An ACP-agent row drives a locally installed agent CLI over the Agent Client
 * Protocol (src/adapters/acp) — the agent owns its harness, tools, workspace
 * and session memory, and bills whatever account the CLI itself is signed
 * into. Today the registry adapter is `acp` for every such row (`devin-acp`,
 * `antigravity-acp`, and any future profile), so the adapter is the identity —
 * same reasoning as subscription-cli.ts.
 *
 * Like a subscription CLI row, `keyOptional` means "no API key", NOT "free":
 * the user's agent subscription is billed by the vendor CLI, so pricing
 * surfaces exclude ACP rows from the Free tier exactly as they do claude-cli.
 */
const ACP_ADAPTERS: ReadonlySet<string> = new Set(["acp"]);

export function isAcpProvider(provider: { adapter?: string | null }): boolean {
  return ACP_ADAPTERS.has((provider.adapter ?? "").trim());
}
