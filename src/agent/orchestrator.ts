import type { PlannerAdapter, PlannerSession } from "./types.js";
import { LocalToolRegistry } from "./tools.js";
import { MemoryStore } from "./memory.js";
import { loadProjectContext } from "./project-context.js";

const MAX_ROUNDS = 10;
const MAX_CONTEXT_CHARS = 40000;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";

export interface AgentEvent {
  type: "init" | "thinking" | "tool_call" | "tool_result" | "answer" | "error" | "step";
  data: unknown;
}
export type AgentEventCallback = (event: AgentEvent) => void;

/**
 * Two-brain orchestrator:
 *   ChatGPT = thinker/planner/coder (smart, natural language)
 *   Ollama  = JSON extractor (converts ChatGPT's words into tool calls)
 */
export class ChatGPTAgent {
  private sessions = new Map<string, PlannerSession>();

  constructor(
    private readonly chatgpt: PlannerAdapter,
    private readonly tools: LocalToolRegistry,
    private root: string,
    private readonly onEvent?: AgentEventCallback
  ) {}

  setRoot(r: string): void { this.root = r; }
  resetSession(id?: string): void {
    if (id) this.sessions.delete(id); else this.sessions.clear();
  }

  async run(userMessage: string, conversationId = "default"): Promise<string> {
    // Get or create ChatGPT session
    let session = this.sessions.get(conversationId);
    const isFirst = !session;
    if (!session) {
      this.emit({ type: "init", data: "Starting session…" });
      session = await this.chatgpt.startSession();
      this.sessions.set(conversationId, session);
    }

    // Build ChatGPT prompt
    const prompt = await this.buildChatGPTPrompt(userMessage, isFirst);
    this.emit({ type: "thinking", data: { message: userMessage } });

    // Send to ChatGPT
    let chatResponse = await this.chatgpt.sendTurn(session, prompt);
    if (!chatResponse.ok || !chatResponse.raw) {
      // Retry with fresh session
      this.sessions.delete(conversationId);
      session = await this.chatgpt.startSession();
      this.sessions.set(conversationId, session);
      chatResponse = await this.chatgpt.sendTurn(session, prompt);
      if (!chatResponse.ok || !chatResponse.raw) return `⚠️ ${chatResponse.message}`;
    }

    const toolLog: string[] = [];

    // Back-and-forth loop
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Ask Ollama to extract actions from ChatGPT's response
      const actions = await this.extractActions(chatResponse.raw!, userMessage);

      // If Ollama says "done" or found no actions, ChatGPT's response IS the answer
      if (!actions.length || (actions.length === 1 && actions[0].action === "done")) {
        const answer = actions[0]?.result ?? chatResponse.raw!;
        if (toolLog.length) return toolLog.join("\n\n") + "\n\n" + answer;
        return answer;
      }

      // Execute each action
      const results: string[] = [];
      let wroteFiles = false;

      for (const action of actions) {
        if (action.action === "done") continue;

        const toolName = action.action;
        const toolArgs = action.args ?? {};
        const reason = action.reason ?? toolName;

        this.emit({ type: "step", data: { step: `💡 ${reason}` } });
        this.emit({ type: "tool_call", data: { tool: toolName, reason } });

        const toolResult = await this.tools.execute(toolName as any, toolArgs, {
          root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
          saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
        });

        this.emit({ type: "tool_result", data: { tool: toolName, ok: toolResult.ok, message: toolResult.message } });

        // Build log entry
        let detail = `${toolResult.ok ? "✅" : "❌"} **${toolName}**${reason !== toolName ? ` — ${reason}` : ""}: ${toolResult.message}`;

        // Diff for writes
        if (toolResult.ok && ["write_file", "apply_patch", "replace_text"].includes(toolName)) {
          wroteFiles = true;
          const fp = (toolArgs as any).path ?? "";
          if (fp) {
            const diff = await this.tools.execute("git_diff" as any, { path: fp }, {
              root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
              saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
            });
            const d = (diff.data as any)?.stdout ?? "";
            if (d.trim()) detail += `\n\n\`\`\`diff\n${d.slice(0, 3000)}\n\`\`\``;
          }
        }

        // Command output
        if (toolResult.ok && ["run_command", "run_tests", "run_build"].includes(toolName)) {
          const out = ((toolResult.data as any)?.stdout ?? "") + ((toolResult.data as any)?.stderr ?? "");
          if (out.trim()) detail += `\n\n\`\`\`\n${out.trim().slice(0, 2000)}\n\`\`\``;
        }

        toolLog.push(detail);

        // Collect results to send back to ChatGPT
        const resultSummary = toolResult.ok
          ? `${toolName} succeeded: ${toolResult.message}\n${safeStringify(toolResult.data, 4000)}`
          : `${toolName} failed: ${toolResult.message}`;
        results.push(resultSummary);
      }

      // If we wrote files, we're probably done
      if (wroteFiles) {
        return toolLog.join("\n\n") + "\n\n✅ Changes applied.";
      }

      // Send results back to ChatGPT for next round
      const followUp = [
        "Here are the results of the actions you requested:\n",
        ...results.map((r, i) => `${i + 1}. ${r}`),
        "\nNow continue with the task. If you need to write/update files, provide the complete file content. If you're done, give your final answer."
      ].join("\n");

      chatResponse = await this.chatgpt.sendTurn(session, followUp);
      if (!chatResponse.ok || !chatResponse.raw) {
        if (toolLog.length) return toolLog.join("\n\n") + "\n\n✅ Task completed.";
        return `⚠️ ${chatResponse.message}`;
      }
    }

    return toolLog.join("\n\n") + "\n\n⚠️ Reached max rounds.";
  }

  /**
   * Ask Ollama to extract structured actions from ChatGPT's natural language response.
   * Ollama is great at this — it's a simple extraction task.
   */
  private async extractActions(chatgptResponse: string, originalTask: string): Promise<any[]> {
    const extractPrompt = [
      "Extract tool actions from the following AI response. Output a JSON array of actions.",
      "Each action: {\"action\":\"<tool>\",\"args\":{...},\"reason\":\"short reason\"}",
      "",
      "Available tools: read_file, read_multiple_files, write_file, search, list_files, run_command, git_diff, git_status",
      "",
      "Rules:",
      "- If the response contains a complete file to write, extract it as write_file with the full content.",
      "- If the response asks to read/inspect files, extract as read_file.",
      "- If the response asks to run a command, extract as run_command.",
      "- If the response is a final answer with no actions needed, return: [{\"action\":\"done\",\"result\":\"the answer\"}]",
      "- If the response contains code blocks with file paths (like ```README.md), extract as write_file.",
      "- Output ONLY the JSON array. No other text.",
      "",
      `Original task: ${originalTask}`,
      "",
      "AI Response to extract from:",
      chatgptResponse.slice(0, 8000)
    ].join("\n");

    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [{ role: "user", content: extractPrompt }],
          stream: false,
          options: { temperature: 0, num_predict: 4096 }
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!res.ok) return [];
      const body = await res.json() as { message?: { content?: string } };
      const raw = body.message?.content?.trim() ?? "";

      // Parse the JSON array
      let text = raw;
      const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      if (fenced) text = fenced[1].trim();

      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.filter(a => a && typeof a.action === "string");
        if (parsed && typeof parsed.action === "string") return [parsed];
      } catch {}

      // Try to find array in text
      const arrMatch = text.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try {
          const parsed = JSON.parse(arrMatch[0]);
          if (Array.isArray(parsed)) return parsed.filter(a => a && typeof a.action === "string");
        } catch {}
      }

      return [];
    } catch {
      return [];
    }
  }

  private async buildChatGPTPrompt(userMessage: string, isFirst: boolean): Promise<string> {
    const parts: string[] = [];

    if (isFirst) {
      const projectCtx = await loadProjectContext(this.root);
      const memoryCtx = await new MemoryStore(this.root).buildContextBlock();
      const fileTree = await this.getFileTree();

      parts.push("You are a coding assistant working on a project. I can execute file operations and commands for you.");
      parts.push("");
      parts.push("When you need to:");
      parts.push("- Read a file: say \"I need to read path/to/file\"");
      parts.push("- Write a file: output the COMPLETE content in a code block tagged with the file path:");
      parts.push("  ```path/to/file.md");
      parts.push("  full content here");
      parts.push("  ```");
      parts.push("- Run a command: say \"Run: `command`\"");
      parts.push("- Search: say \"Search for: pattern\"");
      parts.push("");
      parts.push("Be direct. Don't ask permission. Just tell me what you need or provide the file content.");
      parts.push("For file updates, ALWAYS provide the COMPLETE file, not just the changed parts.");
      parts.push("");
      parts.push(`Workspace: ${this.root}`);
      if (fileTree) parts.push(`\nFiles:\n${fileTree}`);
      if (projectCtx) parts.push(`\n${projectCtx.slice(0, 1500)}`);
      if (memoryCtx) parts.push(`\n${memoryCtx.slice(0, 1500)}`);
    }

    parts.push(`\n${userMessage}`);

    let prompt = parts.join("\n");
    if (prompt.length > MAX_CONTEXT_CHARS) prompt = prompt.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]";
    return prompt;
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
      id: "agent", goal: "", root: this.root, plannerBackend: "dual",
      safetyMode: "auto", status: "running", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), steps: [], changedFiles: [],
      verification: { sawGitDiff: false, sawVerification: false }
    };
  }

  private emit(event: AgentEvent): void { this.onEvent?.(event); }
}

function safeStringify(data: unknown, maxLen: number): string {
  try { const s = JSON.stringify(data); return s.length > maxLen ? s.slice(0, maxLen) + "..." : s; }
  catch { return "{}"; }
}
