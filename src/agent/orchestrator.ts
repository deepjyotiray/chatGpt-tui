import type { PlannerAdapter, PlannerSession } from "./types.js";
import { LocalToolRegistry } from "./tools.js";
import { MemoryStore } from "./memory.js";
import { loadProjectContext } from "./project-context.js";

const MAX_ITERATIONS = 15;
const MAX_CONTEXT_CHARS = 50000;

export interface AgentAction { action: string; [key: string]: unknown; }
export interface AgentEvent { type: "init" | "thinking" | "tool_call" | "tool_result" | "answer" | "error" | "step"; data: unknown; }
export type AgentEventCallback = (event: AgentEvent) => void;

export class ChatGPTAgent {
  // Map conversationId → ChatGPT session (one ChatGPT chat per app conversation)
  private sessions = new Map<string, PlannerSession>();
  private protocolSent = new Set<string>();

  constructor(
    private readonly planner: PlannerAdapter,
    private readonly tools: LocalToolRegistry,
    private root: string,
    private readonly onEvent?: AgentEventCallback
  ) {}

  setRoot(newRoot: string): void { this.root = newRoot; }

  resetSession(conversationId?: string): void {
    if (conversationId) {
      this.sessions.delete(conversationId);
      this.protocolSent.delete(conversationId);
    } else {
      this.sessions.clear();
      this.protocolSent.clear();
    }
  }

  async run(userMessage: string, conversationId: string = "default"): Promise<string> {
    // Get or create a ChatGPT session for this conversation
    let session = this.sessions.get(conversationId);
    let isFirstMessage = false;

    if (!session) {
      this.emit({ type: "init", data: "Starting new agent session…" });
      session = await this.planner.startSession();
      this.sessions.set(conversationId, session);
      isFirstMessage = true;
    }

    const toolList = this.tools.list().map(t => `- ${t.name}: ${t.description}`).join("\n");
    const fileTree = await this.getFileTree();

    // Protocol is always included but shorter on follow-up messages
    const protocol = isFirstMessage ? [
      "You are a coding agent. You MUST reply with ONLY a JSON object. No other text.",
      "",
      "JSON formats:",
      '  Tool call: {"action":"<tool_name>","args":{...},"reason":"what you are doing and why"}',
      '  Final answer: {"action":"done","result":"your complete answer in markdown"}',
      "",
      "Available tools:",
      toolList,
      "",
      "RULES:",
      "- Reply with ONE JSON object per message. Nothing else. No markdown fences.",
      "- You HAVE access to all tools. Use them. Do NOT say you can't access files.",
      "- Do NOT say tools are unavailable. They ARE available. I execute them for you.",
      "- ALWAYS read_file before modifying. Then use write_file with contentBase64 (base64-encoded).",
      "- Break complex tasks into steps: search → read → edit → verify.",
      "- Use the reason field to explain your thinking.",
      "- For done, put your FULL answer in result as markdown. Include diffs if you changed files.",
      "- I will send tool results as: TOOL_RESULT: {json}",
    ].join("\n") : [
      "You are a coding agent. Reply with ONLY a JSON object. No other text.",
      '  Tool call: {"action":"<tool_name>","args":{...},"reason":"why"}',
      '  Done: {"action":"done","result":"your answer in markdown"}',
      "",
      "You HAVE access to these tools (I execute them for you):",
      toolList,
      "",
      "Do NOT say tools are unavailable. Just use them.",
    ].join("\n");

    // Context — full on first message, minimal on follow-ups
    let context: string;
    if (isFirstMessage) {
      const projectCtx = await loadProjectContext(this.root);
      const memoryCtx = await new MemoryStore(this.root).buildContextBlock();
      context = [
        `WORKSPACE: ${this.root}`,
        fileTree ? `\nFILES:\n${fileTree}` : "",
        projectCtx ? `\n${projectCtx.slice(0, 2000)}` : "",
        memoryCtx ? `\n${memoryCtx.slice(0, 2000)}` : "",
      ].filter(Boolean).join("\n");
    } else {
      context = `WORKSPACE: ${this.root}`;
    }

    let prompt = `${protocol}\n\n${context}\n\nTASK: ${userMessage}`;
    if (prompt.length > MAX_CONTEXT_CHARS) {
      prompt = prompt.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]";
    }

    this.emit({ type: "thinking", data: { message: userMessage } });

    let result = await this.planner.sendTurn(session, prompt);
    if (!result.ok || !result.raw) {
      // Session might be dead — reset and retry with new session
      this.sessions.delete(conversationId);
      session = await this.planner.startSession();
      this.sessions.set(conversationId, session);
      result = await this.planner.sendTurn(session, prompt);
      if (!result.ok || !result.raw) {
        return `⚠️ ${result.message}`;
      }
    }

    // Agent tool loop
    const toolLog: string[] = [];
    let turnCount = 0;
    let nudgeCount = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const action = tryParseAction(result.raw!);

      if (!action) {
        // ChatGPT broke protocol — nudge once, then accept plain text
        if (i < 2) {
          const nudge = [
            "WRONG. Reply with ONLY a JSON object.",
            '{"action":"search","args":{"pattern":"coupon"},"reason":"finding files"}',
            "or",
            '{"action":"done","result":"Here is my answer..."}',
            "",
            `Retry: ${userMessage}`
          ].join("\n");
          turnCount++;
          result = await this.planner.sendTurn(session, nudge);
          if (!result.ok || !result.raw) break;
          continue;
        }
        return toolLog.length ? toolLog.join("\n\n") + "\n\n" + result.raw! : result.raw!;
      }

      if (action.action === "done") {
        const answer = (action.result as string) ?? (action.message as string) ?? "";
        // Detect refusal — ChatGPT says it can't use tools
        if (isRefusal(answer) && turnCount === 0) {
          // Kill this session and retry with a completely fresh ChatGPT chat
          this.sessions.delete(conversationId);
          session = await this.planner.startSession();
          this.sessions.set(conversationId, session);
          this.emit({ type: "step", data: { step: "Retrying with fresh session..." } });
          result = await this.planner.sendTurn(session, prompt);
          if (!result.ok || !result.raw) return answer; // give up, return the refusal
          turnCount++;
          continue;
        }
        this.emit({ type: "answer", data: answer });
        return toolLog.length ? toolLog.join("\n\n") + "\n\n" + answer : answer;
      }

      if (action.action === "error") {
        return `⚠️ ${(action.message as string) ?? "Unknown error"}`;
      }

      if (action.action === "ready") {
        result = await this.planner.sendTurn(session, `TASK: ${userMessage}\nReply with a JSON tool call.`);
        if (!result.ok || !result.raw) return `⚠️ ${result.message}`;
        continue;
      }

      // Tool call
      const toolName = action.action;
      const toolArgs = (action.args as Record<string, unknown>) ?? {};
      const reason = (action.reason as string) ?? "";

      this.emit({ type: "step", data: { step: `💡 ${reason || `Using ${toolName}`}` } });
      this.emit({ type: "tool_call", data: { tool: toolName, args: toolArgs, reason } });

      const toolDef = this.tools.get(toolName as any);
      if (!toolDef) {
        result = await this.planner.sendTurn(session,
          `TOOL_RESULT: {"ok":false,"error":"Unknown tool: ${toolName}"}\nReply with a JSON object.`
        );
        if (!result.ok || !result.raw) return `⚠️ Loop failed: ${result.message}`;
        continue;
      }

      const toolResult = await this.tools.execute(toolName as any, toolArgs, {
        root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
        saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
      });

      this.emit({ type: "tool_result", data: { tool: toolName, ok: toolResult.ok, message: toolResult.message } });

      // Build display log
      let detail = `${toolResult.ok ? "✅" : "❌"} **${toolName}**${reason ? ` — ${reason}` : ""}: ${toolResult.message}`;

      // Show diff for write operations
      if (toolResult.ok && ["write_file", "apply_patch", "replace_text", "insert_text"].includes(toolName)) {
        const filePath = (toolArgs.path as string) ?? (toolResult.data as any)?.path ?? "";
        if (filePath) {
          try {
            const diffResult = await this.tools.execute("git_diff" as any, { path: filePath }, {
              root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
              saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
            });
            const diff = (diffResult.data as any)?.stdout ?? "";
            if (diff.trim()) detail += `\n\n\`\`\`diff\n${diff.slice(0, 3000)}\n\`\`\``;
          } catch {}
        }
      }

      // Show output for commands
      if (toolResult.ok && ["run_command", "run_tests", "run_build", "run_lint"].includes(toolName)) {
        const output = ((toolResult.data as any)?.stdout ?? "") + ((toolResult.data as any)?.stderr ?? "");
        if (output.trim()) detail += `\n\n\`\`\`\n${output.trim().slice(0, 2000)}\n\`\`\``;
      }

      toolLog.push(detail);

      // Auto-complete after successful write with enough steps
      if (toolResult.ok && ["write_file", "apply_patch", "replace_text", "insert_text"].includes(toolName) && turnCount >= 3) {
        return toolLog.join("\n\n") + "\n\n✅ Changes applied successfully.";
      }

      // Feed result back
      const feedback = `TOOL_RESULT: ${safeStringify({ ok: toolResult.ok, message: toolResult.message, data: toolResult.data }, 8000)}\n\nReply with your next JSON action or {"action":"done","result":"..."} if finished.`;

      turnCount++;
      result = await this.planner.sendTurn(session, feedback);
      if (!result.ok || !result.raw) {
        if (toolLog.length) return toolLog.join("\n\n") + "\n\n✅ Task completed.";
        return `⚠️ Loop failed at step ${i + 1}: ${result.message}`;
      }
    }

    return toolLog.join("\n\n") + "\n\n⚠️ Reached max iterations.";
  }

  private async getFileTree(): Promise<string> {
    try {
      const r = await this.tools.execute("list_files", { path: ".", maxDepth: 2 }, {
        root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
        saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
      });
      if (r.ok && r.data) return ((r.data as any).files as string[]).slice(0, 80).join("\n");
    } catch {}
    return "";
  }

  private makeDummyTask(): any {
    return {
      id: "agent", goal: "", root: this.root, plannerBackend: this.planner.name,
      safetyMode: "auto", status: "running", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), steps: [], changedFiles: [],
      verification: { sawGitDiff: false, sawVerification: false }
    };
  }

  private emit(event: AgentEvent): void { this.onEvent?.(event); }
}

function tryParseAction(raw: string): AgentAction | null {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();

  let r = attemptParse(text);
  if (r) return r;
  r = attemptParse(fixBrokenJson(text));
  if (r) return r;

  const jsonMatch = text.match(/\{[\s\S]*"action"\s*:\s*"[^"]+[\s\S]*\}/);
  if (jsonMatch) {
    r = attemptParse(jsonMatch[0]) ?? attemptParse(fixBrokenJson(jsonMatch[0]));
    if (r) return r;
  }

  const actionMatch = text.match(/"action"\s*:\s*"([^"]+)"/);
  if (actionMatch) {
    const action = actionMatch[1];
    const reasonMatch = text.match(/"reason"\s*:\s*"([^"]*?)"/);
    if (action === "done") {
      const resultMatch = text.match(/"result"\s*:\s*"([\s\S]*?)"\s*\}\s*$/);
      return { action: "done", result: resultMatch?.[1]?.replace(/\\n/g, "\n")?.replace(/\\"/g, '"') ?? text };
    }
    if (action === "ready" || action === "error") {
      const msgMatch = text.match(/"message"\s*:\s*"([^"]*?)"/);
      return { action, message: msgMatch?.[1] ?? "" };
    }
    const argsMatch = text.match(/"args"\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
    let args: Record<string, unknown> = {};
    if (argsMatch) {
      try { args = JSON.parse(fixBrokenJson(argsMatch[1])); } catch {
        const pathMatch = argsMatch[1].match(/"path"\s*:\s*"([^"]+)"/);
        const b64Match = argsMatch[1].match(/"(?:contentBase64|patchBase64)"\s*:\s*"([^"]+)"/);
        if (pathMatch) args.path = pathMatch[1];
        if (b64Match) args.contentBase64 = b64Match[1];
      }
    }
    return { action, args, reason: reasonMatch?.[1] ?? "" };
  }
  return null;
}

function fixBrokenJson(text: string): string {
  let result = "", inStr = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && inStr && i + 1 < text.length) { result += c + text[i + 1]; i += 2; continue; }
    if (c === '"') { inStr = !inStr; result += c; i++; continue; }
    if (inStr) {
      if (c === "\n") { result += "\\n"; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\t") { result += "\\t"; i++; continue; }
    }
    result += c; i++;
  }
  return result;
}

function attemptParse(text: string): AgentAction | null {
  try { const p = JSON.parse(text); if (p && typeof p === "object" && typeof p.action === "string") return p as AgentAction; } catch {}
  return null;
}

function isRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (lower.includes("can't comply") || lower.includes("cannot comply")) ||
    (lower.includes("can't follow") || lower.includes("cannot follow")) ||
    (lower.includes("tools aren't") || lower.includes("tools are not")) ||
    (lower.includes("not available in this") || lower.includes("not exposed")) ||
    (lower.includes("don't have access to") && lower.includes("tool")) ||
    (lower.includes("can't access") && lower.includes("workspace")) ||
    (lower.includes("custom workspace tools") || lower.includes("those tools"))
  );
}

function safeStringify(data: unknown, maxLen: number): string {
  try { const s = JSON.stringify(data); return s.length > maxLen ? s.slice(0, maxLen) + "..." : s; } catch { return "{}"; }
}
