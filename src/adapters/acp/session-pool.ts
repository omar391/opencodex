/**
 * Persistent ACP agent sessions.
 *
 * A cold turn spawns `agy acp` / `devin acp`, runs initialize + session/new,
 * answers one prompt, and historically killed the process — so every Codex
 * turn paid process spawn + agent boot (~4s for agy) plus a session/load
 * history replay that grows with the thread. Pooled sessions keep the agent
 * process and its loaded session alive across turns: a warm turn only sends
 * set_config_option + session/prompt.
 *
 * The pool is keyed by `${providerId}:${sessionId}`; the continuation state
 * round-trips through ocx's response store, so the next turn in a thread
 * finds its live session. Sessions idle-reap after POOL_IDLE_MS and the pool
 * is capped at POOL_MAX with LRU eviction. Set OPENCODEX_ACP_SESSION_POOL=0
 * to disable pooling entirely (every turn takes the cold path).
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { MAX_ACP_LINE_BYTES } from "./protocol";

const POOL_IDLE_MS = 10 * 60_000;
const POOL_MAX = 8;
const IDLE_ENV = "OPENCODEX_ACP_SESSION_IDLE_MS";
const POOL_ENV = "OPENCODEX_ACP_SESSION_POOL";
/** Warm-path request ids start above the cold path's fixed ids (1-5). */
const FIRST_WARM_ID = 100;

export function acpSessionPoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[POOL_ENV]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function acpSessionPoolKey(providerId: string, sessionId: string): string {
  return `${providerId}:${sessionId}`;
}

/**
 * Thread affinity key for clients that never chain previous_response_id
 * (Codex sends store:false + full history): the request's own thread id keeps
 * one warm agent session per conversation instead of one per response.
 */
export function acpThreadPoolKey(providerId: string, threadId: string): string {
  return `${providerId}:thread:${threadId}`;
}

/** Per-turn callbacks the pooled session routes agent frames into. */
export interface PooledAcpTurnHandlers {
  onUpdate: (update: Record<string, unknown>) => void;
  onPermission: (id: number | string, params: unknown) => void;
  onProtocolError: (message: string) => void;
  onDead: (detail: string) => void;
  isSettled: () => boolean;
}

export interface PooledAcpSession {
  key: string;
  /** Every pool-map key that resolves to this session (session id + thread alias). */
  keys: string[];
  providerId: string;
  binary: string;
  cwd: string;
  sessionId: string;
  /** Config-option ids the agent advertised at session creation. */
  configIds: string[];
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  stderrTail: string;
  nextId: number;
  pending: Map<number, (frame: Record<string, unknown>) => void>;
  /** Active turn's frame router; undefined while the session is idle. */
  turn?: PooledAcpTurnHandlers;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Promise tail serializing turns on this session. */
  tail: Promise<void>;
  lastUsed: number;
  dead: boolean;
}

const pool = new Map<string, PooledAcpSession>();

export function getPooledAcpSession(key: string): PooledAcpSession | undefined {
  const session = pool.get(key);
  if (!session || session.dead) return undefined;
  if (session.child.exitCode !== null || session.child.signalCode !== null) return undefined;
  return session;
}

export function pooledSessionCount(): number {
  return new Set(pool.values()).size;
}

/** Test hook: drop every pooled session. */
export function resetAcpSessionPool(): void {
  for (const session of pool.values()) {
    session.dead = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    try { session.child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  pool.clear();
}

function idleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[IDLE_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : POOL_IDLE_MS;
}

function armIdleTimer(session: PooledAcpSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    dropAcpSession(session.key);
  }, idleMs());
  session.idleTimer.unref?.();
}

/** A turn finished (or the session was adopted): clear the router, re-arm idle. */
export function noteAcpSessionActivity(session: PooledAcpSession): void {
  session.turn = undefined;
  session.lastUsed = Date.now();
  armIdleTimer(session);
}

export function dropAcpSession(key: string): void {
  const session = pool.get(key);
  if (!session) return;
  session.dead = true;
  for (const k of session.keys) pool.delete(k);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  for (const resolve of session.pending.values()) {
    resolve({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: "ACP session process exited" } });
  }
  session.pending.clear();
  try { session.child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => {
    try { session.child.kill("SIGKILL"); } catch { /* already gone */ }
  }, 2_000).unref?.();
}

function evictIfNeeded(): void {
  while (pool.size >= POOL_MAX) {
    let oldest: PooledAcpSession | undefined;
    for (const session of pool.values()) {
      if (!oldest || session.lastUsed < oldest.lastUsed) oldest = session;
    }
    if (!oldest) return;
    dropAcpSession(oldest.key);
  }
}

function sendRaw(session: PooledAcpSession, frame: Record<string, unknown>): void {
  if (!session.child.stdin.destroyed) {
    session.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }
}

/** Write a frame without tracking a response (notifications, cancels). */
export function acpSessionSend(session: PooledAcpSession, frame: Record<string, unknown>): void {
  sendRaw(session, frame);
}

/** Write a request frame and resolve with the agent's response frame. */
export function acpSessionRequest(session: PooledAcpSession, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (session.dead) {
      resolve({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: "ACP session is closed" } });
      return;
    }
    const id = session.nextId++;
    session.pending.set(id, resolve);
    sendRaw(session, { ...frame, id });
  });
}

function idOf(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function handleFrame(session: PooledAcpSession, frame: Record<string, unknown>): void {
  // Agent -> client requests carry a method and their own id space.
  if (frame.method === "session/request_permission" && frame.id != null && session.turn && !session.turn.isSettled()) {
    session.turn.onPermission(frame.id as number | string, frame.params);
    return;
  }
  const id = idOf(frame.id);
  if (id !== undefined) {
    const resolve = session.pending.get(id);
    if (resolve) {
      session.pending.delete(id);
      resolve(frame);
      return;
    }
  }
  if (frame.method === "session/update" && session.turn && !session.turn.isSettled()) {
    const update = (frame.params as { update?: Record<string, unknown> } | undefined)?.update;
    if (update) session.turn.onUpdate(update);
  }
}

function wireSession(session: PooledAcpSession): void {
  session.child.stderr?.setEncoding("utf8");
  session.child.stderr?.on("data", (chunk: string) => {
    session.stderrTail = (session.stderrTail + chunk).slice(-4096);
  });
  session.child.stdout.setEncoding("utf8");
  session.child.stdout.on("data", (chunk: string) => {
    session.buffer += chunk;
    let index: number;
    while ((index = session.buffer.indexOf("\n")) >= 0) {
      const line = session.buffer.slice(0, index);
      session.buffer = session.buffer.slice(index + 1);
      dispatchLine(session, line);
    }
    if (Buffer.byteLength(session.buffer, "utf8") > MAX_ACP_LINE_BYTES) {
      session.buffer = "";
      session.turn?.onProtocolError("ACP agent emitted a single line larger than the frame cap.");
    }
  });
  const onDead = (detail: string) => {
    if (session.dead) return;
    session.dead = true;
    for (const k of session.keys) pool.delete(k);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    for (const resolve of session.pending.values()) {
      resolve({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: `ACP session process ${detail}` } });
    }
    session.pending.clear();
    session.turn?.onDead(session.stderrTail.trim().slice(-400) || detail);
  };
  session.child.on("close", (code) => onDead(`exited (code ${code ?? "null"})`));
  // "exit" fires even while a grandchild holds the stdio pipes; "close" can
  // lag until every pipe holder exits.
  session.child.once("exit", (code) => onDead(`exited (code ${code ?? "null"})`));
  session.child.on("error", () => onDead("failed"));
}

function dispatchLine(session: PooledAcpSession, raw: string): void {
  const line = raw.trim();
  if (!line) return;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(line) as Record<string, unknown>;
  } catch {
    session.turn?.onProtocolError("ACP agent emitted a malformed ACP frame.");
    return;
  }
  handleFrame(session, frame);
}

/**
 * Hand a finished cold-path child + session to the pool. The caller must have
 * already decided the turn completed cleanly; the child's stdout 'data'
 * listeners from the turn stay attached but early-return once settled, so the
 * pool's own listener is the only consumer that acts.
 */
export function adoptAcpSession(init: {
  key: string;
  providerId: string;
  binary: string;
  cwd: string;
  sessionId: string;
  configIds: string[];
  child: ChildProcessWithoutNullStreams;
  leftoverBuffer?: string;
  /** Extra pool keys (e.g. thread affinity) resolving to this same session. */
  aliases?: string[];
}): PooledAcpSession | undefined {
  if (!acpSessionPoolEnabled()) return undefined;
  const keys = [init.key, ...(init.aliases ?? []).filter(k => k !== init.key)];
  for (const k of keys) {
    const existing = pool.get(k);
    if (existing) dropAcpSession(k);
  }
  evictIfNeeded();
  const session: PooledAcpSession = {
    key: init.key,
    keys,
    providerId: init.providerId,
    binary: init.binary,
    cwd: init.cwd,
    sessionId: init.sessionId,
    configIds: init.configIds,
    child: init.child,
    buffer: init.leftoverBuffer ?? "",
    stderrTail: "",
    nextId: FIRST_WARM_ID,
    pending: new Map(),
    tail: Promise.resolve(),
    lastUsed: Date.now(),
    dead: false,
  };
  for (const k of keys) pool.set(k, session);
  wireSession(session);
  // The leftover may already hold complete lines.
  if (session.buffer) {
    let index: number;
    while ((index = session.buffer.indexOf("\n")) >= 0) {
      const line = session.buffer.slice(0, index);
      session.buffer = session.buffer.slice(index + 1);
      dispatchLine(session, line);
    }
  }
  armIdleTimer(session);
  return session;
}
