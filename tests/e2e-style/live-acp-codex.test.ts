import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Live end-to-end: Codex CLI -> local ocx proxy -> `opencode acp` agent.
 *
 * Opt-in only: requires `OCX_ACP_E2E=1`, the `codex` and `opencode` binaries on
 * PATH, and a running ocx service (default http://127.0.0.1:10100). The test
 * builds an isolated CODEX_HOME so the user's real Codex state is untouched,
 * then runs two turns: a cold `codex exec` and a `codex exec resume --last`
 * warm turn that must reuse the pooled ACP session (no second `opencode acp`
 * process may appear).
 *
 *   OCX_ACP_E2E=1 bun test tests/e2e-style/live-acp-codex.test.ts
 */

const ENABLED = process.env.OCX_ACP_E2E === "1";
const PROXY_BASE = process.env.OCX_ACP_E2E_BASE ?? "http://127.0.0.1:10100";
const MODEL = process.env.OCX_ACP_E2E_MODEL ?? "opencode-acp/opencode/big-pickle";
const MARKER = "ACP-E2E-OK";

type CodexExecOptions = { args: string[]; codexHome: string; cwd: string };

function runCodexExec({ args, codexHome, cwd }: CodexExecOptions) {
  return Bun.spawnSync(["codex", "exec", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
}

function acpAgentProcessCount(): number {
  const result = Bun.spawnSync(["pgrep", "-f", "opencode acp"], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return 0;
  return result.stdout.toString().split("\n").filter(line => line.trim().length > 0).length;
}

async function assertProxyHealthy() {
  const res = await fetch(`${PROXY_BASE}/healthz`, { signal: AbortSignal.timeout(5_000) });
  expect(res.ok).toBe(true);
}

describe.skipIf(!ENABLED)("live codex -> ocx -> opencode acp", () => {
  test("cold exec answers and resume reuses the pooled agent session", async () => {
    expect(Bun.which("codex")).toBeTruthy();
    expect(Bun.which("opencode")).toBeTruthy();
    await assertProxyHealthy();

    const codexHome = mkdtempSync(join(tmpdir(), "ocx-acp-e2e-home-"));
    const workdir = mkdtempSync(join(tmpdir(), "ocx-acp-e2e-work-"));
    try {
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "ocx-acp-e2e" }),
      );
      writeFileSync(
        join(codexHome, "config.toml"),
        `openai_base_url = "${PROXY_BASE}/v1"\n`,
      );

      const cold = runCodexExec({
        codexHome,
        cwd: workdir,
        args: ["-m", MODEL, "--skip-git-repo-check", `Reply with exactly: ${MARKER}`],
      });
      expect(cold.exitCode).toBe(0);
      expect(cold.stdout.toString()).toContain(MARKER);

      const pooledCount = acpAgentProcessCount();
      expect(pooledCount).toBeGreaterThan(0);

      const warm = runCodexExec({
        codexHome,
        cwd: workdir,
        args: [
          "resume", "--last", "--skip-git-repo-check", "-m", MODEL,
          "What exact token did I ask you to reply with earlier? Reply with only that token.",
        ],
      });
      expect(warm.exitCode).toBe(0);
      expect(warm.stdout.toString()).toContain(MARKER);

      // Warm turn must not spawn another `opencode acp`: the pooled session
      // carries the thread's context, proven by the marker recall above.
      expect(acpAgentProcessCount()).toBe(pooledCount);
    } finally {
      removeTreeWithRetry(codexHome);
      removeTreeWithRetry(workdir);
    }
  }, 480_000);
});
