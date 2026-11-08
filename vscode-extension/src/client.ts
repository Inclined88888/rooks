// The AI Workspace API, with no VS Code imports so it can be tested with plain Node (test/*.test.mjs).
//
// Auth: the "Terminal access" token from the app (Assistant settings) as a Bearer token; the backend accepts it on
// the assistant routes (require_user_or_cli). State-changing calls also carry X-Workbench: 1 (the app's CSRF guard).

import * as fs from "node:fs";
import * as path from "node:path";

export type TurnEvent =
  | { type: "start"; conversation_id: number }
  | { type: "thought"; content: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; ok: boolean; preview: string }
  | { type: "approval_required" | "approval_denied"; id: number; tool: string }
  | { type: "router"; [k: string]: unknown }
  | { type: "message"; content: string }
  | { type: "error"; error: string }
  | { type: "done"; conversation_id: number; cost_cents: number; tool_calls: number }
  | { type: string; [k: string]: unknown };

/** The server install's address (docker-compose.yml publishes the app on port 3100). */
export const SERVER_URL = "http://127.0.0.1:3100";

/** app.json, which the open desktop app writes and removes when it quits. Same place the `rooks` terminal reads it
 * (rooks-code/rooks_code/config.py: app_link_path). */
export function appLinkPath(env: Record<string, string | undefined>, platform: string, home: string): string {
  if (env.AI_WORKSPACE_APP_FILE) return env.AI_WORKSPACE_APP_FILE;
  if (platform === "win32" && env.APPDATA) return path.win32.join(env.APPDATA, "ai-workspace", "app.json");
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), "ai-workspace", "app.json");
}

export type FindOptions = {
  env: Record<string, string | undefined>; platform: string; home: string; fetchImpl?: typeof fetch; timeoutMs?: number;
};

/** The open app's address, or "" when it is not open. Only the address is read: the key next to it is the app's
 * bridge key, which the add-on never uses (it signs in with its own Terminal access token). A file left by an app
 * that is no longer running is ignored, as rooks ignores it (it asks /healthz first). */
export async function findAppUrl(o: FindOptions): Promise<string> {
  let url = "";
  try {
    const d = JSON.parse(fs.readFileSync(appLinkPath(o.env, o.platform, o.home), "utf8")) as { url?: unknown };
    url = String(d?.url ?? "").replace(/\/+$/, "");
  } catch {
    return "";
  }
  if (!/^https?:\/\/[^/]+$/.test(url)) return "";
  try {
    const r = await (o.fetchImpl ?? fetch)(`${url}/healthz`, { signal: AbortSignal.timeout(o.timeoutMs ?? 1500) });
    return r.ok ? url : "";
  } catch {
    return "";
  }
}

/** The address to use: the aiWorkspace.url setting when set, else the open app, else the server install. */
export function resolveUrl(setting: string | undefined, found: string): string {
  return ((setting ?? "").trim() || found || SERVER_URL).replace(/\/+$/, "");
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Splits an SSE byte stream into `data:` JSON events. Feed chunks; complete events come back, the rest is kept. */
export class SseParser {
  private buf = "";
  push(chunk: string): unknown[] {
    this.buf += chunk.replace(/\r\n/g, "\n");
    const out: unknown[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try { out.push(JSON.parse(data)); } catch { /* a malformed event is skipped, never fatal */ }
    }
    return out;
  }
}

export type Context = { selection?: string; fileName?: string; languageId?: string; maxChars?: number };

/** The message sent for a question, with the selected code attached as a fenced block. */
export function buildMessage(question: string, ctx: Context = {}): string {
  const q = question.trim();
  if (!ctx.selection || !ctx.selection.trim()) return q;
  const max = ctx.maxChars ?? 20000;
  let code = ctx.selection;
  let cut = "";
  if (code.length > max) { code = code.slice(0, max); cut = `\n(selection cut to the first ${max} characters)`; }
  const fence = code.includes("```") ? "````" : "```";
  const where = ctx.fileName ? ` from ${ctx.fileName}` : "";
  return `${q}\n\nCode${where}:\n${fence}${ctx.languageId ?? ""}\n${code}\n${fence}${cut}`;
}

export const EXPLAIN = "Explain what this code does, step by step, and point out anything risky or surprising.";

export type ChatOptions = {
  url: string; token: string; message: string; conversationId?: number; model?: string;
  onEvent?: (e: TurnEvent) => void; signal?: AbortSignal; fetchImpl?: typeof fetch;
};

/** One assistant turn. Streams events to onEvent and resolves with the final answer and conversation id. */
export async function chat(o: ChatOptions): Promise<{ conversationId: number | undefined; answer: string; events: TurnEvent[] }> {
  const f = o.fetchImpl ?? fetch;
  const base = o.url.replace(/\/+$/, "");
  const body: Record<string, unknown> = { message: o.message, channel: "cli" };
  if (o.conversationId) body.conversation_id = o.conversationId;
  if (o.model) body.model = o.model;
  const r = await f(`${base}/api/assistant/chat`, {
    method: "POST", signal: o.signal,
    headers: { "Content-Type": "application/json", "X-Workbench": "1", Authorization: `Bearer ${o.token}`, Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = "";
    try { detail = ((await r.json()) as { detail?: string }).detail ?? ""; } catch { /* not JSON */ }
    if (r.status === 401) throw new ApiError(401, "AI Workspace rejected the token. Create one in the app (Assistant, Terminal access) and run 'AI Workspace: Set terminal access token'.");
    if (r.status === 404 && o.conversationId) throw new ApiError(404, "That conversation no longer exists.");
    throw new ApiError(r.status, detail || `AI Workspace answered ${r.status}`);
  }
  if (!r.body) throw new ApiError(502, "No response body");
  const parser = new SseParser();
  const events: TurnEvent[] = [];
  let conversationId = o.conversationId;
  let answer = "";
  const decoder = new TextDecoder();
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
    for (const raw of parser.push(chunk + (done ? "\n\n" : ""))) {
      const e = (typeof raw === "object" && raw && !("type" in raw) && "error" in raw ? { type: "error", ...(raw as object) } : raw) as TurnEvent;
      events.push(e);
      if (e.type === "start" || e.type === "done") conversationId = (e as { conversation_id: number }).conversation_id ?? conversationId;
      if (e.type === "message") answer = (e as { content: string }).content;
      o.onEvent?.(e);
    }
    if (done) break;
  }
  const err = events.find((e) => e.type === "error") as { error: string } | undefined;
  if (err && !answer) throw new ApiError(502, err.error);
  return { conversationId, answer, events };
}

/** One line for the output panel per event (empty string = don't show). */
export function describe(e: TurnEvent, appUrl: string): string {
  switch (e.type) {
    case "tool_call": return `  -> ${(e as { name: string }).name.replace(/_/g, " ")}`;
    case "tool_result": { const t = e as { name: string; ok: boolean }; return t.ok ? "" : `  !! ${t.name.replace(/_/g, " ")} failed`; }
    case "approval_required": { const a = e as { id: number; tool: string };
      return `  ?? Waiting for your OK in AI Workspace: ${a.tool.replace(/_/g, " ")} (#${a.id}) - ${appUrl.replace(/\/+$/, "")}/assistant`; }
    case "approval_denied": return `  xx ${(e as { tool: string }).tool.replace(/_/g, " ")} was not allowed`;
    case "error": return `Error: ${(e as { error: string }).error}`;
    default: return "";
  }
}
