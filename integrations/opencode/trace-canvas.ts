/**
 * Trace Canvas plugin for OpenCode 2.
 *
 * OpenCode's prompt, tool and session events are turned into the Claude Code shape
 * `trace-canvas hook` reads, then handed to it in the background: a slow or broken canvas must
 * never hold up the agent.
 *
 * Installed by `trace-canvas setup --user --agents opencode` as
 * ~/.config/opencode/plugins/trace-canvas.ts, linked to this file.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Payload = Record<string, unknown>;

/** The parts of OpenCode's plugin context and event objects this adapter uses. */
interface PluginContext {
  location?: { directory?: string };
  session: { hook(name: "prompt", handler: (event: PromptEvent) => void): Promise<unknown> };
  tool: {
    hook(name: "execute.before", handler: (event: ToolEvent) => void): Promise<unknown>;
    hook(name: "execute.after", handler: (event: ToolEvent) => void): Promise<unknown>;
  };
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<ServerEvent> };
}
interface ContentPart {
  type?: string;
  text?: string;
}
interface PromptEvent {
  sessionID: string;
  messageID?: string;
  prompt?: { text?: string };
}
interface ToolEvent {
  tool?: string;
  sessionID: string;
  id?: string;
  input?: Record<string, unknown>;
  result?: { content?: ContentPart[]; output?: { output?: string } };
}
interface ServerEvent {
  id?: string;
  type: string;
  location?: { directory?: string };
  data?: { sessionID?: string; text?: string };
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

function send(payload: Payload): void {
  const cmd = command();
  if (!cmd) return;
  try {
    const child = spawn(cmd[0], [cmd[1], "hook", "--agent", "opencode"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
    child.unref();
  } catch {}
}

// The plugin loads once per location and the event stream is server-wide, so each copy keeps its own.
function real(dir?: string): string {
  if (!dir) return "";
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

// OpenCode names its tools in lower case and passes `path` where Claude passes `file_path`.
const EDITS: Record<string, string> = { write: "Write", edit: "Edit", patch: "Edit", multiedit: "MultiEdit" };
const STOP_EVENTS: Record<string, true> = { "session.execution.succeeded": true, "session.execution.failed": true, "session.execution.interrupted": true };

function toolName(name: unknown): string {
  const n = String(name || "");
  return n === "shell" ? "Bash" : EDITS[n] || n;
}

function toolInput(name: unknown, input: Record<string, unknown> | undefined): Record<string, unknown> {
  const i = input && typeof input === "object" ? input : {};
  if (toolName(name) === "Bash") {
    const command = Array.isArray(i.command) ? i.command.join(" ") : i.command;
    return { ...i, command: typeof command === "string" ? command : "" };
  }
  const file = i.file_path || i.path || i.filePath;
  return file ? { ...i, file_path: file } : i;
}

function toolResponse(event: ToolEvent): Record<string, unknown> {
  const result = event?.result;
  if (!result) return {};
  const stdout = Array.isArray(result.content) ? result.content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\n") : "";
  return { stdout: result.output?.output ?? stdout };
}

export default {
  id: "trace-canvas",
  async setup(ctx: PluginContext) {
    const cwd = ctx.location?.directory || process.cwd();
    const here = real(cwd);
    // The last assistant text per session, so a settled turn records what it ended with.
    const lastText = new Map<string, string>();

    await ctx.session.hook("prompt", event => {
      send({ hook_event_name: "UserPromptSubmit", session_id: event.sessionID, cwd, prompt: event.prompt?.text || "", prompt_id: event.messageID });
    });

    await ctx.tool.hook("execute.before", event => {
      send({
        hook_event_name: "PreToolUse",
        session_id: event.sessionID,
        cwd,
        tool_name: toolName(event.tool),
        tool_input: toolInput(event.tool, event.input),
        tool_use_id: event.id,
      });
    });

    await ctx.tool.hook("execute.after", event => {
      send({
        hook_event_name: "PostToolUse",
        session_id: event.sessionID,
        cwd,
        tool_name: toolName(event.tool),
        tool_input: toolInput(event.tool, event.input),
        tool_use_id: event.id,
        tool_response: toolResponse(event),
      });
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.location?.directory && real(event.location.directory) !== here) continue;
        const sessionID = event.data?.sessionID;
        if (!sessionID) continue;
        if (event.type === "session.text.ended" && event.data?.text) lastText.set(sessionID, String(event.data.text));
        else if (STOP_EVENTS[event.type]) {
          send({
            hook_event_name: "Stop",
            session_id: sessionID,
            cwd,
            last_assistant_message: lastText.get(sessionID) || "",
            prompt_id: `${sessionID}:${event.id || event.type}`,
          });
          lastText.delete(sessionID);
        } else if (event.type === "session.deleted") {
          send({ hook_event_name: "SessionEnd", session_id: sessionID, cwd, reason: "session deleted" });
        }
      }
    })().catch(() => {});

    return () => controller.abort();
  },
};
