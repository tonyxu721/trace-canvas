/**
 * Trace Canvas hook for omp (oh-my-pi).
 *
 * omp's hook events are turned into the Claude Code shape `trace-canvas hook` reads, then handed to
 * it in the background: a slow or broken canvas must never hold up the agent.
 *
 * Installed by `trace-canvas setup --user --agents omp` as
 * ~/.omp/agent/hooks/pre/trace-canvas.ts, linked to this file.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Payload = Record<string, unknown>;

/** The parts of omp's hook API and event objects this adapter uses. */
interface HookContext {
  cwd?: string;
  sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined };
}
interface HookApi {
  on<E>(event: string, handler: (event: E, ctx: HookContext) => void): void;
}
interface ContentPart {
  type?: string;
  text?: string;
}
interface ToolEvent {
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  content?: ContentPart[];
  details?: { resolvedPath?: string };
}
interface Message {
  role?: string;
  content?: ContentPart[];
}
interface StopEvent {
  session_id?: string;
  turn_id?: number;
  stop_hook_active?: boolean;
  last_assistant_message?: unknown;
  messages?: Message[];
}

// Where `setup` left the CLI. Env vars win, so a second checkout can be used without reinstalling.
function command(): [string, string] | null {
  const env = process.env;
  if (env.TRACE_CANVAS_NODE && env.TRACE_CANVAS_CLI) return [env.TRACE_CANVAS_NODE, env.TRACE_CANVAS_CLI];
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".trace-canvas", "integrations.json"), "utf8"));
    if (cfg && typeof cfg.node === "string" && typeof cfg.cli === "string" && existsSync(cfg.cli)) return [cfg.node, cfg.cli];
  } catch {}
  return null;
}
function run(payload: Payload): Promise<void> {
  const cmd = command();
  if (!cmd) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => resolve();
  try {
    const child = spawn(cmd[0], [cmd[1], "hook", "--agent", "omp"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
    const timer = setTimeout(done, 10000);
    child.on("error", done);
    child.on("close", () => { clearTimeout(timer); done(); });
    child.stdin?.on("error", done);
    child.stdin?.end(JSON.stringify(payload));
    child.unref();
  } catch { done(); }
  return promise;
}

// One hook process at a time: Stop reads the state PostToolUse wrote, and SessionEnd drops it, so
// they must run in the order omp emitted them. Stop and SessionEnd are awaited; the rest are not.
let tail: Promise<void> = Promise.resolve();
const queue = (payload: Payload): Promise<void> => (tail = tail.then(() => run(payload)));

const textOf = (content: ContentPart[] | undefined): string =>
  Array.isArray(content) ? content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\n") : "";

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Message).content;
  return Array.isArray(content) ? textOf(content) : "";
}

// omp names its tools in lower case and passes `path` where Claude passes `file_path`.
const EDITS: Record<string, string> = { write: "Write", edit: "Edit", multiedit: "MultiEdit", patch: "Edit" };

function toolName(name: unknown): string {
  const n = String(name || "");
  return n === "bash" ? "Bash" : EDITS[n] || n;
}

function toolInput(name: unknown, input: Record<string, unknown> | undefined): Record<string, unknown> {
  const i = input && typeof input === "object" ? input : {};
  if (toolName(name) === "Bash") {
    const command = Array.isArray(i.command) ? i.command.join(" ") : i.command;
    return { ...i, command: typeof command === "string" ? command : "" };
  }
  const file = i.file_path || i.path;
  return file ? { ...i, file_path: file } : i;
}

export default function (pi: HookApi) {
  const base = (ctx: HookContext): Payload => ({ session_id: sessionId(ctx), cwd: ctx.cwd || process.cwd() });

  pi.on("session_start", (_event: unknown, ctx) => {
    const payload: Payload = { ...base(ctx), hook_event_name: "SessionStart" };
    const file = ctx.sessionManager?.getSessionFile?.();
    if (file) payload.transcript_path = file;
    void queue(payload);
  });

  // One per instruction, before the agent loop starts on it.
  pi.on<{ prompt?: unknown }>("before_agent_start", (event, ctx) => {
    if (!event?.prompt) return;
    void queue({ ...base(ctx), hook_event_name: "UserPromptSubmit", prompt: String(event.prompt) });
  });

  pi.on<ToolEvent>("tool_call", (event, ctx) => {
    void queue({
      ...base(ctx),
      hook_event_name: "PreToolUse",
      tool_name: toolName(event?.toolName),
      tool_input: toolInput(event?.toolName, event?.input),
      tool_use_id: event?.toolCallId,
    });
  });

  pi.on<ToolEvent>("tool_result", (event, ctx) => {
    const stdout = textOf(event?.content);
    void queue({
      ...base(ctx),
      hook_event_name: "PostToolUse",
      tool_name: toolName(event?.toolName),
      tool_input: toolInput(event?.toolName, event?.input),
      tool_use_id: event?.toolCallId,
      tool_response: event?.details?.resolvedPath ? { stdout, filePath: event.details.resolvedPath } : { stdout },
    });
  });

  // Fires when a turn settles; a stop hook that asked for another turn means it has not settled yet.
  pi.on<StopEvent>("session_stop", (event, ctx) => {
    if (event?.stop_hook_active) return;
    const sid = event?.session_id || sessionId(ctx);
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const last = [...messages].reverse().find(m => m?.role === "assistant");
    const turn = event?.turn_id;
    return queue({
      ...base(ctx),
      session_id: sid,
      hook_event_name: "Stop",
      last_assistant_message: messageText(event?.last_assistant_message) || messageText(last),
      prompt_id: turn == null ? undefined : `${sid}:${turn}`,
    });
  });

  pi.on("session_shutdown", (_event: unknown, ctx) => {
    return queue({ ...base(ctx), hook_event_name: "SessionEnd", reason: "session closed" });
  });
}

function sessionId(ctx: HookContext): string {
  try {
    return ctx.sessionManager?.getSessionId?.() || "";
  } catch {
    return "";
  }
}
