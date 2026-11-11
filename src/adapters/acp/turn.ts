/**
 * One ACP agent turn over stdio: spawn, handshake, prompt, reap.
 *
 * Resurrected from the retired devin-cli ACP adapter and generalized over
 * profiles. The child is treated as untrusted and unprivileged: scoped env,
 * permission requests refused unless the operator opted in, and a real reap
 * ladder (SIGTERM -> grace -> SIGKILL, whole process group on POSIX) because a
 * grandchild that ignores SIGTERM would otherwise keep writing in the
 * operator's tree after the turn returned.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxProviderContinuationState } from "../../types";
import type { IncomingMeta } from "../base";
import { baseScopedEnv } from "../coding-agent/turn";
import { commandInvocation } from "../../lib/win-exec";
import {
  ACP_INITIALIZE_ID,
  ACP_PROMPT_ID,
  ACP_SESSION_ID,
  MAX_ACP_LINE_BYTES,
  MAX_ACP_TOTAL_BYTES,
  acpUpdateToEvents,
  buildAcpHistory,
  buildAcpPrompt,
  initializeFrame,
  lastUserMessageIndex,
  mapAcpStopReason,
  mapAcpUsage,
  permissionResponseFrame,
  sessionCancelFrame,
  sessionLoadFrame,
  sessionNewFrame,
  sessionPromptFrame,
  sessionSetConfigOptionFrame,
  sessionSetModeFrame,
} from "./protocol";
import type { AcpProviderProfile } from "./profiles";
import type { WhichFn } from "../coding-agent/profile";

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 2_000;
const REAP_MS = 5_000;
const MAX_STDERR_TAIL = 4_096;

export type AcpSpawn = (
  binary: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => ChildProcessWithoutNullStreams;

export interface AcpTurnDeps {
  /** Test seam for binary discovery; production uses the shared PATH scan. */
  which?: WhichFn;
  spawn?: AcpSpawn;
  timeoutMs?: number;
  killGraceMs?: number;
  reapTimeoutMs?: number;
  /** Operator opt-in to answer session/request_permission with an allow. */
  toolsAllowed?: boolean;
  /** Test seam: home directory for T3 tool/GEMINI_HOME lookups. */
  homeDir?: string;
}

interface AcpSessionState {
  sessionId?: string;
  cwd?: string;
  modelId?: string;
}

function readSessionState(parsed: OcxParsedRequest): AcpSessionState {
  const cont = parsed._providerContinuation as OcxProviderContinuationState | undefined;
  const acp = cont?.acp as AcpSessionState | undefined;
  return acp && typeof acp.sessionId === "string" ? acp : {};
}

function continuationState(session: AcpSessionState): OcxProviderContinuationState {
  return { acp: { sessionId: session.sessionId, cwd: session.cwd, modelId: session.modelId } };
}

/** Opt-in env shared by every ACP profile: lets permission requests be allowed. */
export const ACP_ALLOW_TOOLS_ENV = "OPENCODEX_ACP_ALLOW_TOOLS";

export function acpToolsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ACP_ALLOW_TOOLS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export async function runAcpTurn(input: {
  profile: AcpProviderProfile;
  binary: string;
  provider: OcxProviderConfig;
  parsed: OcxParsedRequest;
  incoming: IncomingMeta;
  emit: (event: AdapterEvent) => void;
  cwd: string;
  deps?: AcpTurnDeps;
}): Promise<void> {
  const { profile, binary, provider, parsed, incoming, emit, cwd } = input;
  const deps = input.deps ?? {};
  const toolsAllowed = deps.toolsAllowed ?? acpToolsAllowed();

  if (incoming.abortSignal?.aborted) {
    emit({ type: "error", message: `${profile.label} turn was aborted before start.` });
    return;
  }

  const spawnChild: AcpSpawn = deps.spawn ?? ((b, args, options) => {
    const inv = commandInvocation(b, args, process.platform, { env: options.env });
    return spawn(inv.file, inv.args, {
      ...inv.options,
      env: options.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
  });

  const prior = readSessionState(parsed);
  const modelId = parsed.modelId;
  const env = { ...baseScopedEnv(), ...(profile.buildEnv?.(provider.apiKey ?? "") ?? {}) };

  await new Promise<void>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnChild(binary, profile.buildArgs(modelId), { cwd, env });
    } catch (error) {
      emit({
        type: "error",
        message: `${profile.label} failed to start (${binary}): ${(error as Error).message}. ${profile.installHint}`,
        status: 500,
        errorType: "upstream_error",
        code: "cli_spawn_failed",
        retryable: false,
      });
      return resolve();
    }

    let settled = false;
    let closed = false;
    let sawProtocolFrame = false;
    let buffer = "";
    let totalBytes = 0;
    let stderrTail = "";
    let usage: import("../../types").OcxUsage | undefined;
    let stopReason: string | undefined;
    let sessionId: string | undefined = prior.sessionId;
    /** True while session/load is replaying history — those updates are swallowed. */
    let suppressReplay = false;
    const promptBlocks: Array<Record<string, unknown>> = [];

    const turnTimer = setTimeout(() => finish(`ACP turn exceeded ${deps.timeoutMs ?? TURN_TIMEOUT_MS}ms`), deps.timeoutMs ?? TURN_TIMEOUT_MS);
    const onAbort = () => {
      if (sessionId) send(sessionCancelFrame(sessionId));
      finish(`${profile.label} turn was aborted.`);
    };

    function reapAndResolve(): void {
      if (closed || child.exitCode !== null || child.signalCode !== null) return resolve();
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        clearTimeout(reapTimer);
        resolve();
      };
      child.once("close", settle);
      signalTree("SIGTERM");
      const killTimer = setTimeout(() => signalTree("SIGKILL"), deps.killGraceMs ?? KILL_GRACE_MS);
      const reapTimer = setTimeout(settle, deps.reapTimeoutMs ?? REAP_MS);
    }

    function signalTree(signal: NodeJS.Signals): void {
      const pid = child.pid;
      if (pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-pid, signal);
          return;
        } catch { /* no group, or already reaped */ }
      }
      try { child.kill(signal); } catch { /* already gone */ }
    }

    function finish(errorMessage?: string, extra?: { status?: number; errorType?: string; code?: string; retryable?: boolean }): void {
      if (settled) return;
      settled = true;
      clearTimeout(turnTimer);
      incoming.abortSignal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      const state = sessionId ? continuationState({ sessionId, cwd, modelId }) : undefined;
      if (errorMessage) {
        emit({
          type: "error",
          message: errorMessage,
          ...(usage ? { usage } : {}),
          ...(extra ?? {}),
        });
      } else {
        emit({
          type: "done",
          ...(usage ? { usage } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(state ? { providerState: state } : {}),
        });
      }
      reapAndResolve();
    }

    incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (incoming.abortSignal?.aborted) return finish(`${profile.label} turn was aborted.`);

    const send = (frame: Record<string, unknown>): void => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    child.stdin.on("error", () => {});
    child.on("error", (err) =>
      finish(`${profile.label} failed to start (${binary}): ${err.message}. ${profile.installHint}`, {
        status: 500, errorType: "upstream_error", code: "cli_spawn_failed", retryable: false,
      }),
    );
    child.on("close", (code) => {
      closed = true;
      if (settled) return;
      flush(buffer);
      buffer = "";
      if (settled) return;
      const detail = stderrTail.trim().slice(-400);
      finish(
        `${profile.label} exited (code ${code ?? "null"}) before answering the prompt` +
          (detail ? `: ${detail}` : "."),
        { status: 502, errorType: "upstream_error", code: "cli_exit", retryable: true },
      );
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_TAIL);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > MAX_ACP_TOTAL_BYTES) return finish("ACP agent produced more output than one turn may consume.");
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        flush(line);
        if (settled) return;
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_ACP_LINE_BYTES) {
        finish("ACP agent emitted a single line larger than the frame cap.");
      }
    });
    child.stdout.on("end", () => {
      const tail = buffer;
      buffer = "";
      flush(tail);
    });

    function flush(raw: string): void {
      const line = raw.trim();
      if (!line || settled) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        if (sawProtocolFrame || line.startsWith("{")) {
          finish(`${profile.label} emitted a malformed ACP frame.`);
        }
        return;
      }
      sawProtocolFrame = true;
      handle(frame);
    }

    const idOf = (value: unknown): number | undefined => {
      if (typeof value === "number") return value;
      if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
      return undefined;
    };

    /** Build the prompt blocks: history for a fresh session, live user turn always. */
    function buildPrompt(): Array<Record<string, unknown>> {
      const userIndex = lastUserMessageIndex(parsed.context);
      const blocks: Array<Record<string, unknown>> = [];
      if (!prior.sessionId && userIndex > 0) {
        const history = buildAcpHistory(parsed.context, userIndex);
        if (history.trim()) blocks.push({ type: "text", text: `[Conversation so far]\n${history}` });
      }
      return [...blocks, ...buildAcpPrompt(parsed.context)];
    }

    function handle(frame: Record<string, unknown>): void {
      if (settled) return;
      const id = idOf(frame.id);
      const error = frame.error as { message?: string; data?: { "cognition.ai/errorKind"?: string; retryable?: boolean } } | undefined;
      const errorMessage = () => error?.message ?? "unknown error";

      if (id === ACP_INITIALIZE_ID) {
        if (error) return finish(`${profile.label} initialize failed: ${errorMessage()}`);
        const result = frame.result as { agentCapabilities?: { loadSession?: boolean } } | undefined;
        if (prior.sessionId && result?.agentCapabilities?.loadSession) {
          suppressReplay = true;
          send(sessionLoadFrame(prior.sessionId, cwd));
        } else {
          send(sessionNewFrame(cwd));
        }
        return;
      }
      if (id === ACP_SESSION_ID) {
        if (error) {
          // A stale sessionId (agent restarted, session deleted) falls back to
          // a fresh session rather than failing the turn.
          if (prior.sessionId && /session.?not.?found|not.?found/i.test(errorMessage())) {
            sessionId = undefined;
            suppressReplay = false;
            send(sessionNewFrame(cwd));
            return;
          }
          return finish(`${profile.label} session failed: ${errorMessage()}`);
        }
        const result = frame.result as { sessionId?: string; modes?: { currentModeId?: string }; configOptions?: unknown } | undefined;
        sessionId = result?.sessionId ?? sessionId;
        if (!sessionId) return finish(`${profile.label} session returned no sessionId.`);
        suppressReplay = false;
        // Model selection via the session's advertised config options: only
        // sent when the agent declares the option id the profile names, so an
        // agent without one keeps its own default instead of erroring.
        const configIds = Array.isArray(result?.configOptions)
          ? (result.configOptions as Array<{ id?: unknown }>).map(o => o?.id).filter((v): v is string => typeof v === "string")
          : [];
        if (profile.modelConfigId && configIds.includes(profile.modelConfigId)) {
          send(sessionSetConfigOptionFrame(sessionId, profile.modelConfigId, modelId));
        }
        if (profile.sessionMode) {
          send(sessionSetModeFrame(sessionId, profile.sessionMode));
        }
        // Config/mode frames precede the prompt on stdin, so the agent applies
        // them in order; their replies (ids 4/5) are ignored by handle().
        send(sessionPromptFrame(sessionId, buildPrompt()));
        return;
      }
      if (frame.method === "session/request_permission" && frame.id != null) {
        const params = frame.params as { options?: Array<{ optionId?: string; name?: string; kind?: string }> } | undefined;
        send(permissionResponseFrame(frame.id as number | string, params?.options, toolsAllowed));
        return;
      }
      if (frame.method === "session/update") {
        if (suppressReplay) return;
        const update = (frame.params as { update?: Record<string, unknown> } | undefined)?.update;
        if (!update) return;
        for (const event of acpUpdateToEvents(update)) emit(event);
        return;
      }
      if (id === ACP_PROMPT_ID) {
        if (error) {
          const kind = error.data?.["cognition.ai/errorKind"];
          return finish(`${profile.label} session/prompt failed: ${errorMessage()}`, {
            status: 502,
            errorType: "upstream_error",
            code: kind ?? "acp_prompt_failed",
            retryable: error.data?.retryable !== false,
          });
        }
        const result = frame.result as { stopReason?: unknown; usage?: unknown } | undefined;
        usage = mapAcpUsage(result?.usage) ?? usage;
        stopReason = mapAcpStopReason(result?.stopReason);
        finish();
      }
    }

    send(initializeFrame(process.env.OPENCODEX_VERSION ?? "0.0.0"));
  });
}
