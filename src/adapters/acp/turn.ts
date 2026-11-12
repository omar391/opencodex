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
  composeEffortModelId,
  sessionSetConfigOptionFrame,
  sessionSetModeFrame,
} from "./protocol";
import type { AcpProviderProfile } from "./profiles";
import type { WhichFn } from "../coding-agent/profile";
import {
  acpSessionPoolEnabled,
  acpSessionPoolKey,
  acpSessionRequest,
  acpSessionSend,
  acpThreadPoolKey,
  adoptAcpSession,
  getPooledAcpSession,
  noteAcpSessionActivity,
  type PooledAcpSession,
} from "./session-pool";

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 2_000;
const REAP_MS = 5_000;
const MAX_STDERR_TAIL = 4_096;
// ACP agents go quiet for minutes during long tool runs; heartbeats keep the
// upstream stall watchdog from killing a healthy turn.
const HEARTBEAT_INTERVAL_MS = 30_000;

// Agents report billing exhaustion as ordinary assistant text, not a protocol
// error — without interception the notice streams out as a successful answer
// and combo failover never engages. Hold the first text deltas briefly: a
// short reply that is entirely a quota/billing notice becomes a failover
// error; anything longer or mixed with other content flushes and streams on.
const ACP_QUOTA_TEXT_RE = /individual quota|quota (?:reached|exceeded|exhausted)|usage limits? (?:reached|exceeded)|rate.?limits?(?:ed)?\b|insufficient (?:credits|balance|quota)|upgrade your subscription|resets? in \d/i;
const TEXT_GATE_MAX_CHARS = 1_500;
const TEXT_GATE_MS = 1_200;

function createAcpTextGate(emit: (event: AdapterEvent) => void) {
  let pending = "";
  let open = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (pending) {
      const text = pending;
      pending = "";
      emit({ type: "text_delta", text } as AdapterEvent);
    }
  };
  const gated = (event: AdapterEvent): void => {
    if (event.type === "text_delta" && typeof event.text === "string" && event.text.length > 0) {
      if (!open) {
        pending += event.text;
        if (pending.length >= TEXT_GATE_MAX_CHARS) { open = true; flush(); }
        else if (!timer) {
          timer = setTimeout(() => { open = true; flush(); }, TEXT_GATE_MS);
          timer.unref?.();
        }
        return;
      }
    } else if (!open && pending) {
      open = true;
      flush();
    }
    emit(event);
  };
  return {
    emit: gated,
    /** Buffered agent text while the gate never opened; undefined once flushed. */
    heldText: (): string | undefined => (open ? undefined : pending || undefined),
    close: () => { if (timer) clearTimeout(timer); },
  };
}

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
  /** Force the ACP session pool on/off; default follows OPENCODEX_ACP_SESSION_POOL and the spawn seam. */
  sessionPool?: boolean;
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
  providerId?: string;
  parsed: OcxParsedRequest;
  incoming: IncomingMeta;
  emit: (event: AdapterEvent) => void;
  cwd: string;
  deps?: AcpTurnDeps;
}): Promise<void> {
  const { profile, binary, provider, parsed, incoming, cwd } = input;
  const textGate = createAcpTextGate(input.emit);
  const emit = textGate.emit;
  const deps = input.deps ?? {};
  const toolsAllowed = deps.toolsAllowed ?? acpToolsAllowed();
  // Pooling is on for real spawns; a custom spawn seam means a test harness
  // that expects one process per turn, unless the test opts in explicitly.
  const poolingAllowed = (deps.sessionPool ?? deps.spawn === undefined) && acpSessionPoolEnabled();

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
  // Effort-suffix agents spell the rung into the wire model id; the roster
  // carries base ids and the caller's reasoning option selects the rung.
  const modelId = profile.effortSuffix
    ? composeEffortModelId(parsed.modelId, parsed.options?.reasoning, profile.effortSuffix)
    : parsed.modelId;
  const env = { ...baseScopedEnv(), ...(profile.buildEnv?.(provider.apiKey ?? "", binary) ?? {}) };

  // Warm path: the continuation state's sessionId belongs to a live pooled
  // agent — skip spawn/initialize/session-load entirely and prompt in place.
  // Clients that never chain previous_response_id (Codex store:false) instead
  // affinity on the request's own thread id, which the pool aliases at adopt.
  // A compaction turn skips the warm lookup (its rewritten history must seed a
  // fresh session) but still claims the thread alias so later turns land on
  // the post-compaction session, not the stale pre-compaction one.
  const ownThreadId = parsed._codexOwnThreadId ?? parsed._clientThreadId;
  const lookupAffinity = parsed._compactionRequest ? undefined : ownThreadId;
  const warmKey = (key: string | undefined) => {
    if (!key || !poolingAllowed || !input.providerId) return undefined;
    const session = getPooledAcpSession(key);
    return session && session.cwd === cwd && session.binary === binary ? session : undefined;
  };
  const pooled = warmKey(prior.sessionId && input.providerId ? acpSessionPoolKey(input.providerId, prior.sessionId) : undefined)
    ?? warmKey(lookupAffinity && input.providerId ? acpThreadPoolKey(input.providerId, lookupAffinity) : undefined);
  if (pooled) {
    return runPooledAcpTurn({ profile, parsed, incoming, emit, cwd, session: pooled, deps, toolsAllowed });
  }

  await new Promise<void>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnChild(binary, profile.buildArgs(modelId, binary), { cwd, env });
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
    /** Config-option ids the agent advertised at session creation (for pool adoption). */
    let sessionConfigIds: string[] = [];
    /** True while session/load is replaying history — those updates are swallowed. */
    let suppressReplay = false;
    const promptBlocks: Array<Record<string, unknown>> = [];

    const turnTimer = setTimeout(() => finish(`ACP turn exceeded ${deps.timeoutMs ?? TURN_TIMEOUT_MS}ms`), deps.timeoutMs ?? TURN_TIMEOUT_MS);
    const heartbeatTimer = setInterval(() => {
      if (!settled) emit({ type: "heartbeat" });
    }, HEARTBEAT_INTERVAL_MS);
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
      clearInterval(heartbeatTimer);
      incoming.abortSignal?.removeEventListener("abort", onAbort);
      // A clean completion hands the live agent + session to the pool so the
      // next turn in this thread skips spawn/handshake/session-load entirely.
      // Errors and aborts still reap the process.
      const quotaHeld = !errorMessage ? textGate.heldText() : undefined;
      const quotaExceeded = quotaHeld !== undefined && ACP_QUOTA_TEXT_RE.test(quotaHeld);
      let adopted = false;
      if (!errorMessage && !quotaExceeded && sessionId && poolingAllowed && input.providerId) {
        adopted = adoptAcpSession({
          key: acpSessionPoolKey(input.providerId, sessionId),
          providerId: input.providerId,
          binary,
          cwd,
          sessionId,
          configIds: sessionConfigIds,
          child,
          leftoverBuffer: buffer,
          aliases: ownThreadId ? [acpThreadPoolKey(input.providerId, ownThreadId)] : undefined,
        }) !== undefined;
      }
      if (!adopted) child.stdout.destroy();
      const state = sessionId ? continuationState({ sessionId, cwd, modelId }) : undefined;
      textGate.close();
      if (errorMessage || quotaExceeded) {
        emit({
          type: "error",
          message: errorMessage ?? `${profile.label} reported quota exhaustion: ${quotaHeld!.trim().slice(0, 200)}`,
          ...(usage ? { usage } : {}),
          ...(errorMessage ? (extra ?? {}) : { status: 429, errorType: "rate_limit_error", code: "acp_quota_exhausted", retryable: true }),
        });
      } else {
        emit({
          type: "done",
          ...(usage ? { usage } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(state ? { providerState: state } : {}),
        });
      }
      if (adopted) resolve();
      else reapAndResolve();
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
    // "exit" fires on process termination even while a grandchild still holds
    // the stdio pipes — "close" alone can lag indefinitely when the agent
    // spawned a tool subprocess that outlives it.
    child.once("exit", (code) => {
      if (settled) return;
      flush(buffer);
      buffer = "";
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

    // The prompt is held until the model config-option ack arrives: an agent
    // that rejects the model must fail the turn with its own message instead of
    // silently answering on the default model.
    let promptSent = false;
    let awaitingModelAck = false;
    function sendPrompt(): void {
      if (promptSent || !sessionId) return;
      promptSent = true;
      send(sessionPromptFrame(sessionId, buildPrompt()));
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
        sessionConfigIds = configIds;
        if (profile.modelConfigId && configIds.includes(profile.modelConfigId)) {
          awaitingModelAck = true;
          send(sessionSetConfigOptionFrame(sessionId, profile.modelConfigId, modelId));
        }
        if (profile.sessionMode) {
          send(sessionSetModeFrame(sessionId, profile.sessionMode));
        }
        // Config/mode frames precede the prompt on stdin, so the agent applies
        // them in order; the prompt waits for the model ack (id 5) so a rejected
        // model surfaces the agent's own error instead of running the default.
        if (!awaitingModelAck) sendPrompt();
        return;
      }
      if (id === 5 && awaitingModelAck) {
        awaitingModelAck = false;
        if (error) {
          const data = error.data as { availableModels?: unknown } | undefined;
          const available = Array.isArray(data?.availableModels)
            ? data.availableModels.filter((v): v is string => typeof v === "string")
            : [];
          const suffix = available.length ? ` Available: ${available.join(", ")}.` : "";
          return finish(`${profile.label} model selection failed: ${errorMessage()}${suffix}`, {
            status: 502,
            errorType: "upstream_error",
            code: "acp_model_rejected",
            retryable: false,
          });
        }
        sendPrompt();
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

/**
 * Warm path: run one prompt on a pooled, already-initialized ACP session.
 * Skips spawn/initialize/session-load — the agent keeps its harness, tools,
 * and conversation state; only the new user turn is sent.
 */
async function runPooledAcpTurn(input: {
  profile: AcpProviderProfile;
  parsed: OcxParsedRequest;
  incoming: IncomingMeta;
  emit: (event: AdapterEvent) => void;
  cwd: string;
  session: PooledAcpSession;
  deps: AcpTurnDeps;
  toolsAllowed: boolean;
}): Promise<void> {
  const { profile, parsed, incoming, cwd, session, deps, toolsAllowed } = input;
  const textGate = createAcpTextGate(input.emit);
  const emit = textGate.emit;
  const modelId = profile.effortSuffix
    ? composeEffortModelId(parsed.modelId, parsed.options?.reasoning, profile.effortSuffix)
    : parsed.modelId;
  const sessionId = session.sessionId;

  if (incoming.abortSignal?.aborted) {
    emit({ type: "error", message: `${profile.label} turn was aborted before start.` });
    return;
  }

  // ACP agents process one prompt per session at a time; chain turns.
  const previous = session.tail;
  let release!: () => void;
  session.tail = new Promise<void>((resolveTail) => { release = resolveTail; });
  await previous;

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      let usage: import("../../types").OcxUsage | undefined;
      let stopReason: string | undefined;

      const turnTimer = setTimeout(() => finish(`${profile.label} turn exceeded ${deps.timeoutMs ?? TURN_TIMEOUT_MS}ms`), deps.timeoutMs ?? TURN_TIMEOUT_MS);
      const heartbeatTimer = setInterval(() => {
        if (!settled) emit({ type: "heartbeat" });
      }, HEARTBEAT_INTERVAL_MS);

      const onAbort = () => {
        acpSessionSend(session, sessionCancelFrame(sessionId));
        finish(`${profile.label} turn was aborted.`);
      };

      function finish(errorMessage?: string, extra?: { status?: number; errorType?: string; code?: string; retryable?: boolean }): void {
        if (settled) return;
        settled = true;
        clearTimeout(turnTimer);
        clearInterval(heartbeatTimer);
        incoming.abortSignal?.removeEventListener("abort", onAbort);
        noteAcpSessionActivity(session);
        release();
        const state = continuationState({ sessionId, cwd, modelId });
        const quotaHeld = !errorMessage ? textGate.heldText() : undefined;
        const quotaExceeded = quotaHeld !== undefined && ACP_QUOTA_TEXT_RE.test(quotaHeld);
        textGate.close();
        if (errorMessage || quotaExceeded) {
          emit({
            type: "error",
            message: errorMessage ?? `${profile.label} reported quota exhaustion: ${quotaHeld!.trim().slice(0, 200)}`,
            ...(usage ? { usage } : {}),
            ...(errorMessage ? (extra ?? {}) : { status: 429, errorType: "rate_limit_error", code: "acp_quota_exhausted", retryable: true }),
          });
        } else {
          emit({
            type: "done",
            ...(usage ? { usage } : {}),
            ...(stopReason ? { stopReason } : {}),
            providerState: state,
          });
        }
        resolve();
      }

      incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (incoming.abortSignal?.aborted) return finish(`${profile.label} turn was aborted.`);

      session.turn = {
        isSettled: () => settled,
        onUpdate: (update) => {
          for (const event of acpUpdateToEvents(update)) emit(event);
        },
        onPermission: (id, params) => {
          const options = (params as { options?: Array<{ optionId?: string; name?: string; kind?: string }> } | undefined)?.options;
          acpSessionSend(session, permissionResponseFrame(id, options, toolsAllowed));
        },
        onProtocolError: (message) => finish(`${profile.label} ${message}`, {
          status: 502, errorType: "upstream_error", code: "acp_protocol_error", retryable: true,
        }),
        onDead: (detail) => finish(`${profile.label} session process ${detail} mid-turn.`, {
          status: 502, errorType: "upstream_error", code: "cli_exit", retryable: true,
        }),
      };

      void (async () => {
        try {
          // Same contract as the cold path: hold the prompt until the model
          // config ack so a rejected model fails with the agent's own message.
          if (profile.modelConfigId && session.configIds.includes(profile.modelConfigId)) {
            const response = await acpSessionRequest(
              session,
              sessionSetConfigOptionFrame(sessionId, profile.modelConfigId, modelId),
            );
            if (settled) return;
            if (response.error) {
              const error = response.error as { message?: string; data?: { availableModels?: unknown } };
              const available = Array.isArray(error.data?.availableModels)
                ? error.data.availableModels.filter((v): v is string => typeof v === "string")
                : [];
              const suffix = available.length ? ` Available: ${available.join(", ")}.` : "";
              return finish(`${profile.label} model selection failed: ${error.message ?? "unknown error"}${suffix}`, {
                status: 502,
                errorType: "upstream_error",
                code: "acp_model_rejected",
                retryable: false,
              });
            }
          }
          const response = await acpSessionRequest(
            session,
            sessionPromptFrame(sessionId, buildAcpPrompt(parsed.context)),
          );
          if (settled) return;
          if (response.error) {
            const error = response.error as { message?: string; data?: { "cognition.ai/errorKind"?: string; retryable?: boolean } };
            return finish(`${profile.label} session/prompt failed: ${error.message ?? "unknown error"}`, {
              status: 502,
              errorType: "upstream_error",
              code: error.data?.["cognition.ai/errorKind"] ?? "acp_prompt_failed",
              retryable: error.data?.retryable !== false,
            });
          }
          const result = response.result as { stopReason?: unknown; usage?: unknown } | undefined;
          usage = mapAcpUsage(result?.usage) ?? usage;
          stopReason = mapAcpStopReason(result?.stopReason);
          finish();
        } catch (error) {
          if (!settled) {
            finish(`${profile.label} pooled session failed: ${(error as Error).message}`, {
              status: 502, errorType: "upstream_error", code: "acp_pooled_failed", retryable: true,
            });
          }
        }
      })();
    });
  } finally {
    release();
  }
}
