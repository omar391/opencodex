/**
 * Agent Client Protocol framing for spawn-based ACP providers.
 *
 * An ACP agent speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. One turn
 * is: initialize -> session/new (or session/load for a resumed conversation)
 * -> session/prompt, with session/update notifications streaming in between and
 * a unary reply carrying the stop reason and usage.
 *
 * This module is pure. It never spawns a process and never touches the network,
 * so the framing and the event mapping are testable against captured lines, the
 * same discipline src/adapters/coding-agent/protocol.ts follows for the
 * stream-json CLIs.
 *
 * Unlike the retired devin-cli adapter this serves any ACP agent: the prompt is
 * built from user-role content only — the client harness (system prompt, tool
 * catalog, developer context) is intentionally NOT forwarded, because the agent
 * runs its own harness. That is the contract this adapter exists for.
 */
import type { AdapterEvent, OcxContext, OcxMessage, OcxParsedRequest, OcxUsage } from "../../types";

/** Hard ceiling on a single buffered stdout line. */
export const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;
/** Hard ceiling on total stdout bytes consumed for one turn. */
export const MAX_ACP_TOTAL_BYTES = 64 * 1024 * 1024;
/** Ceiling on the flattened history context handed to a fresh session. */
export const MAX_ACP_HISTORY_CHARS = 120_000;

export class AcpProtocolError extends Error {
  readonly code = "protocol_error";
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

export const ACP_INITIALIZE_ID = 1;
export const ACP_SESSION_ID = 2;
export const ACP_PROMPT_ID = 3;

export function initializeFrame(clientVersion: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: ACP_INITIALIZE_ID,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: { name: "opencodex", version: clientVersion },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    },
  };
}

export function sessionNewFrame(cwd: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: ACP_SESSION_ID, method: "session/new", params: { cwd, mcpServers: [] } };
}

export function sessionLoadFrame(sessionId: string, cwd: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: ACP_SESSION_ID, method: "session/load", params: { sessionId, cwd, mcpServers: [] } };
}

export function sessionSetModeFrame(sessionId: string, modeId: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 4, method: "session/set_mode", params: { sessionId, modeId } };
}

export function sessionPromptFrame(sessionId: string, prompt: Array<Record<string, unknown>>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: ACP_PROMPT_ID, method: "session/prompt", params: { sessionId, prompt } };
}

export function sessionCancelFrame(sessionId: string): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } };
}

/**
 * Answer a permission request without a human.
 *
 * A headless turn has nobody to approve a tool call. The answer is a refusal
 * unless the operator opted in through the profile/env gate; when allowed, the
 * first allow-shaped option is selected — never a positional guess, because the
 * first option in a real prompt is sometimes the rejection.
 */
export function permissionResponseFrame(
  id: number | string,
  options: Array<{ optionId?: string; name?: string; kind?: string }> | undefined,
  allowed = false,
): Record<string, unknown> {
  if (!allowed) {
    return { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
  }
  const list = options ?? [];
  const allow =
    list.find((o) => typeof o.kind === "string" && /^allow/i.test(o.kind)) ??
    list.find((o) => /allow|accept|yes/i.test(`${o.optionId ?? ""} ${o.name ?? ""}`));
  if (!allow?.optionId) {
    return { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
  }
  return { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } };
}

/** ACP prompt content block for one text segment. */
export function textBlock(text: string): Record<string, unknown> {
  return { type: "text", text };
}

/**
 * ACP image block. The wire accepts base64 data + mimeType; Codex image parts
 * arrive as `data:` URLs or remote https URLs. Data URLs convert directly;
 * remote URLs become a text marker because this adapter never fetches.
 */
export function imageBlock(imageUrl: string): Record<string, unknown> | { type: "text"; text: string } {
  const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl);
  if (dataMatch && dataMatch[2]) {
    return { type: "image", data: dataMatch[3], mimeType: dataMatch[1] || "image/png" };
  }
  return { type: "text", text: `[image: ${imageUrl}]` };
}

function messageText(content: OcxMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : part.type === "image" ? `[image]` : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The user's current request as ACP content blocks.
 *
 * Only the LAST user-role message is the live prompt: everything before it is
 * either already inside a resumed session (session/load) or projected as
 * labelled history for a fresh one. Developer/system/harness context is never
 * forwarded — the agent's own harness answers the user's request.
 */
export function buildAcpPrompt(context: OcxContext): Array<Record<string, unknown>> {
  const lastUser = [...context.messages].reverse().find((m): m is Extract<OcxMessage, { role: "user" }> => m.role === "user");
  if (!lastUser) return [textBlock("(empty)")];
  const blocks: Array<Record<string, unknown>> = [];
  if (typeof lastUser.content === "string") {
    blocks.push(textBlock(lastUser.content || "(empty)"));
    return blocks;
  }
  for (const part of lastUser.content) {
    if (part.type === "text") {
      if (part.text) blocks.push(textBlock(part.text));
    } else if (part.type === "image") {
      blocks.push(imageBlock(part.imageUrl));
    }
  }
  return blocks.length > 0 ? blocks : [textBlock("(empty)")];
}

/**
 * Flattened prior conversation for a FRESH session (no resume state).
 *
 * User and assistant text only — the harness context and the client's tool
 * catalog stay out. Tool calls/results that belong to another provider's turn
 * are rendered as records so the agent sees what happened without treating them
 * as its own calls.
 */
export function buildAcpHistory(context: OcxContext, currentUserIndex: number): string {
  const blocks: string[] = [];
  const messages = context.messages.slice(0, currentUserIndex);
  for (const message of messages) {
    if (message.role === "user") {
      const text = messageText(message.content);
      if (text.trim()) blocks.push(fence("User", text));
    } else if (message.role === "assistant") {
      const text = messageText(message.content);
      if (text.trim()) blocks.push(fence("Assistant", text));
    } else if (message.role === "toolResult") {
      const body = typeof message.content === "string" ? message.content : messageText(message.content);
      blocks.push(fence("Tool", `[result ${message.toolCallId}]\n${body}`));
    }
    // developer/system roles are client-harness context and stay out.
  }
  const joined = blocks.join("\n\n");
  return joined.length > MAX_ACP_HISTORY_CHARS
    ? `[truncated]\n${joined.slice(joined.length - MAX_ACP_HISTORY_CHARS)}`
    : joined;
}

/** Index of the last user message — the turn's live prompt boundary. */
export function lastUserMessageIndex(context: OcxContext): number {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i]!.role === "user") return i;
  }
  return -1;
}

/** Fence a block label so a message body cannot forge one. */
function fence(label: string, body: string): string {
  return `[${label}]\n${body.replace(/^\[(User|Assistant|System|Tool)\]/gm, " $&")}`;
}

export type AcpTurnOutcome = { stopReason?: string; usage?: OcxUsage };

/** ACP stop reasons that mean the turn ended normally. */
const NATURAL_STOP = new Set(["end_turn", "stop", "completed"]);

export function mapAcpStopReason(reason: unknown): string | undefined {
  if (typeof reason !== "string" || NATURAL_STOP.has(reason)) return undefined;
  return reason;
}

export function mapAcpUsage(raw: unknown): OcxUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const input = typeof u.inputTokens === "number" ? u.inputTokens : 0;
  const output = typeof u.outputTokens === "number" ? u.outputTokens : 0;
  const cached = typeof u.cachedReadTokens === "number" ? u.cachedReadTokens : undefined;
  if (input === 0 && output === 0 && cached === undefined) return undefined;
  const total = typeof u.totalTokens === "number" ? u.totalTokens : input + output;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(total > 0 ? { totalTokens: total } : {}),
    ...(cached !== undefined && cached > 0 ? { cachedInputTokens: cached, cacheReadInputTokens: cached } : {}),
  };
}

function chunkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function chunkTitle(update: Record<string, unknown>): string {
  const title = update.title ?? update.name ?? update.toolCallId;
  return typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : "tool";
}

/**
 * Translate one session/update notification into adapter events.
 *
 * Message and thought chunks are the answer stream. The agent's own tool
 * lifecycle is agent-internal — it executes its own tools, so tool_call events
 * are NOT client tools; they become thinking-delta progress lines so a long
 * agent turn stays visibly alive instead of emitting bare heartbeats.
 */
export function acpUpdateToEvents(update: Record<string, unknown>): AdapterEvent[] {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = chunkText(update.content);
    return text ? [{ type: "text_delta", text }] : [];
  }
  if (kind === "agent_thought_chunk") {
    const text = chunkText(update.content);
    return text ? [{ type: "thinking_delta", thinking: text }] : [];
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const status = typeof update.status === "string" ? update.status : "";
    const title = chunkTitle(update);
    const suffix = status && status !== "pending" && status !== "in_progress" ? ` (${status})` : "";
    return [{ type: "thinking_delta", thinking: `⚙ ${title}${suffix}` }];
  }
  if (kind === "plan") {
    const entries = Array.isArray(update.entries) ? update.entries.length : 0;
    return [{ type: "thinking_delta", thinking: entries > 0 ? `📋 plan (${entries} steps)` : "📋 plan" }];
  }
  // user_message_chunk (history echo during session/load), session_info_update,
  // available_commands_update, current_mode_update, usage_update and vendor
  // _meta notifications are not client-visible content.
  return [];
}
