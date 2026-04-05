import { promises as fs } from "node:fs";
import path from "node:path";
import type { PlannerAdapter, PlannerSession } from "./types.js";
import { LocalToolRegistry } from "./tools.js";
import { MemoryStore } from "./memory.js";
import { loadProjectContext } from "./project-context.js";

const MAX_ROUNDS = 5;
const MAX_PROMPT_CHARS = 35000;

export interface AgentEvent {
  type: "init" | "thinking" | "tool_call" | "tool_result" | "answer" | "error" | "step";
  data: unknown;
}
export type AgentEventCallback = (event: AgentEvent) => void;

export class ChatGPTAgent {
  private sessions = new Map<string, PlannerSession>();
  private systemPrompt: string | null = null;

  constructor(
    private readonly chatgpt: PlannerAdapter,
    private readonly tools: LocalToolRegistry,
    private root: string,
    private readonly onEvent?: AgentEventCallback
  ) {}

  setRoot(r: string): void { this.root = r; this.systemPrompt = null; }
  resetSession(id?: string): void {
    if (id) this.sessions.delete(id); else this.sessions.clear();
  }

  private async getSystemPrompt(): Promise<string> {
    if (this.systemPrompt) return this.systemPrompt;
    try {
      // Look for AGENT_SYSTEM.md in the project root first, then in the app directory
      for (const loc of [path.join(this.root, "AGENT_SYSTEM.md"), path.resolve("AGENT_SYSTEM.md")]) {
        try {
          this.systemPrompt = await fs.readFile(loc, "utf8");
          return this.systemPrompt;
        } catch {}
      }
    } catch {}
    this.systemPrompt = "You are a coding agent. Use PATCH blocks for edits, CREATE blocks for new files.";
    return this.systemPrompt;
  }

  async run(userMessage: string, conversationId = "default"): Promise<string> {
    const log: string[] = [];

    // Step 1: Gather context
    this.emit({ type: "init", data: "Gathering context…" });
    const context = await this.gatherContext(userMessage, log);

    // Step 2: Build prompt with system instructions + context + task
    const system = await this.getSystemPrompt();
    const prompt = [system, "", context, "", `TASK: ${userMessage}`].join("\n").slice(0, MAX_PROMPT_CHARS);

    // Step 3: Send to ChatGPT
    this.emit({ type: "step", data: { step: "🧠 Asking ChatGPT…" } });
    const session = await this.getSession(conversationId);
    let response = await this.send(session, prompt, conversationId);
    if (!response) return log.join("\n\n") + "\n\n⚠️ No response from ChatGPT.";

    // Step 4: Parse and execute actions — multi-round if NEED requests
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const actions = this.parseActions(response);

      if (!actions.length) {
        // Pure text answer
        return log.length ? log.join("\n\n") + "\n\n" + response : response;
      }

      let needsFollowUp = false;
      const followUpParts: string[] = [];

      for (const action of actions) {
        switch (action.type) {
          case "patch": {
            this.emit({ type: "tool_call", data: { tool: "replace_text", reason: `Patching ${action.path}` } });
            const result = await this.exec("replace_text", {
              path: action.path,
              oldText: action.before,
              newText: action.after
            });
            if (result.ok) {
              log.push(`✅ Patched \`${action.path}\``);
              const diff = await this.exec("git_diff", { path: action.path });
              const d = (diff.data as any)?.stdout ?? "";
              if (d.trim()) log.push("```diff\n" + d.slice(0, 3000) + "\n```");
            } else {
              log.push(`❌ Patch failed on \`${action.path}\`: ${result.message}`);
              followUpParts.push(`PATCH FAILED on ${action.path}: ${result.message}. The exact BEFORE text was not found. Please re-read the file and try again.`);
              needsFollowUp = true;
            }
            break;
          }
          case "create": {
            this.emit({ type: "tool_call", data: { tool: "write_file", reason: `Creating ${action.path}` } });
            const result = await this.exec("write_file", { path: action.path, content: action.content });
            if (result.ok) {
              log.push(`✅ Created \`${action.path}\``);
            } else {
              log.push(`❌ Failed to create \`${action.path}\`: ${result.message}`);
            }
            break;
          }
          case "need": {
            this.emit({ type: "tool_call", data: { tool: "read_file", reason: `Reading ${action.path}` } });
            const result = await this.exec("read_file", { path: action.path });
            if (result.ok) {
              const content = (result.data as any)?.content ?? "";
              followUpParts.push(`--- ${action.path} ---\n${content.slice(0, 8000)}`);
              log.push(`📖 Read \`${action.path}\``);
            } else {
              followUpParts.push(`Could not read ${action.path}: ${result.message}`);
              log.push(`❌ Could not read \`${action.path}\``);
            }
            needsFollowUp = true;
            break;
          }
          case "run": {
            this.emit({ type: "tool_call", data: { tool: "run_command", reason: action.command } });
            const result = await this.exec("run_command", { command: action.command });
            const out = ((result.data as any)?.stdout ?? "") + ((result.data as any)?.stderr ?? "");
            log.push(`🔧 \`${action.command}\`\n\`\`\`\n${out.trim().slice(0, 2000)}\n\`\`\``);
            if (!result.ok) {
              followUpParts.push(`Command failed: ${action.command}\nOutput:\n${out.slice(0, 3000)}`);
              needsFollowUp = true;
            }
            break;
          }
          case "search": {
            this.emit({ type: "tool_call", data: { tool: "search", reason: action.query } });
            const result = await this.exec("search", { pattern: action.query });
            const out = (result.data as any)?.stdout ?? "";
            followUpParts.push(`Search results for "${action.query}":\n${out.slice(0, 3000)}`);
            log.push(`🔍 Searched \`${action.query}\``);
            needsFollowUp = true;
            break;
          }
        }
      }

      if (!needsFollowUp) break;

      // Send follow-up to ChatGPT with results
      this.emit({ type: "step", data: { step: "🧠 Sending results to ChatGPT…" } });
      const followUp = followUpParts.join("\n\n") + "\n\nContinue with the task.";
      response = await this.send(session, followUp, conversationId);
      if (!response) break;
    }

    return log.length ? log.join("\n\n") : "Done.";
  }

  // --- Context gathering ---

  private async gatherContext(task: string, log: string[]): Promise<string> {
    const parts: string[] = [];

    // Project instructions
    const projectCtx = await loadProjectContext(this.root);
    if (projectCtx) parts.push(projectCtx.slice(0, 1500));

    // Memory
    const memoryCtx = await new MemoryStore(this.root).buildContextBlock();
    if (memoryCtx) parts.push(memoryCtx.slice(0, 1500));

    // File tree
    this.emit({ type: "tool_call", data: { tool: "list_files", reason: "Scanning project" } });
    const tree = await this.exec("list_files", { path: ".", maxDepth: 2 });
    const files = tree.ok ? ((tree.data as any)?.files as string[]) ?? [] : [];
    if (files.length) parts.push("PROJECT FILES:\n" + files.slice(0, 100).join("\n"));
    log.push(`📂 Scanned ${files.length} files`);

    // Read relevant files
    const relevant = this.findRelevantFiles(task, files);
    for (const f of relevant.slice(0, 5)) {
      this.emit({ type: "tool_call", data: { tool: "read_file", reason: `Reading ${f}` } });
      const result = await this.exec("read_file", { path: f });
      if (result.ok) {
        const content = (result.data as any)?.content ?? "";
        parts.push(`--- ${f} ---\n${content.slice(0, 5000)}`);
        log.push(`📖 Read \`${f}\``);
      }
    }

    // Git status
    const git = await this.exec("git_status", {});
    if (git.ok) {
      const status = (git.data as any)?.stdout ?? "";
      if (status.trim()) parts.push(`GIT STATUS:\n${status}`);
    }

    return parts.join("\n\n");
  }

  // --- Action parsing ---

  private parseActions(text: string): Array<{type: string; path?: string; before?: string; after?: string; content?: string; command?: string; query?: string}> {
    const actions: Array<any> = [];

    // PATCH: path\n<<<<<<< BEFORE\n...\n=======\n...\n>>>>>>> AFTER
    const patchRegex = /PATCH:\s*([\w./\\-]+\.[\w]{1,10})\s*\n<<<<<<< BEFORE\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> AFTER/g;
    let m;
    while ((m = patchRegex.exec(text)) !== null) {
      actions.push({ type: "patch", path: m[1].trim(), before: m[2], after: m[3] });
    }

    // CREATE: path\n...\nEND_CREATE
    const createRegex = /CREATE:\s*([\w./\\-]+\.[\w]{1,10})\s*\n([\s\S]*?)\nEND_CREATE/g;
    while ((m = createRegex.exec(text)) !== null) {
      actions.push({ type: "create", path: m[1].trim(), content: m[2] });
    }

    // NEED: path
    const needRegex = /NEED:\s*([\w./\\-]+\.[\w]{1,10})/g;
    while ((m = needRegex.exec(text)) !== null) {
      actions.push({ type: "need", path: m[1].trim() });
    }

    // RUN: command
    const runRegex = /RUN:\s*(.+)/g;
    while ((m = runRegex.exec(text)) !== null) {
      const cmd = m[1].trim().replace(/^`|`$/g, "");
      if (cmd.length > 2) actions.push({ type: "run", command: cmd });
    }

    // SEARCH: pattern
    const searchRegex = /SEARCH:\s*(.+)/g;
    while ((m = searchRegex.exec(text)) !== null) {
      const q = m[1].trim();
      if (q.length > 1) actions.push({ type: "search", query: q });
    }

    return actions;
  }

  // --- Helpers ---

  private findRelevantFiles(task: string, allFiles: string[]): string[] {
    const lower = task.toLowerCase();
    const relevant: string[] = [];

    // Direct file mentions
    for (const f of allFiles) {
      const name = f.split("/").pop()?.toLowerCase() ?? "";
      if (name.includes(".") && lower.includes(name.replace(/\.\w+$/, ""))) {
        relevant.push(f);
      }
    }

    // Keyword matching
    const map: Record<string, string[]> = {
      readme: ["README.md"], package: ["package.json"], config: ["tsconfig.json"],
      coupon: ["public/coupons.json"], electron: ["app/main.cjs", "app/preload.cjs"],
      agent: ["src/agent/orchestrator.ts", "AGENT.md"], bridge: ["src/bridge-server.ts", "app/chatgpt-bridge.cjs"],
      api: ["src/api-server.ts"], memory: ["src/agent/memory.ts"], tool: ["src/agent/tools.ts"],
      style: ["app/renderer/styles.css"], html: ["app/renderer/index.html"],
    };
    for (const [kw, files] of Object.entries(map)) {
      if (lower.includes(kw)) {
        for (const f of files) {
          if (allFiles.includes(f) && !relevant.includes(f)) relevant.push(f);
        }
      }
    }

    if (!relevant.includes("package.json") && allFiles.includes("package.json")) relevant.push("package.json");
    return relevant;
  }

  private extractSearchTerms(task: string): string[] {
    const terms: string[] = [];
    const quoted = task.match(/"([^"]+)"|'([^']+)'/g);
    if (quoted) for (const q of quoted) terms.push(q.replace(/['"]/g, ""));
    return terms;
  }

  private async send(session: PlannerSession, prompt: string, conversationId: string): Promise<string | null> {
    const result = await this.chatgpt.sendTurn(session, prompt);
    if (result.ok && result.raw) {
      console.log("[chatgpt]", result.raw.slice(0, 150));
      return result.raw;
    }
    // Retry with fresh session
    this.sessions.delete(conversationId);
    const fresh = await this.getSession(conversationId);
    const retry = await this.chatgpt.sendTurn(fresh, prompt);
    if (retry.ok && retry.raw) {
      console.log("[chatgpt] retry:", retry.raw.slice(0, 150));
      return retry.raw;
    }
    return null;
  }

  private async getSession(conversationId: string): Promise<PlannerSession> {
    let s = this.sessions.get(conversationId);
    if (!s) { s = await this.chatgpt.startSession(); this.sessions.set(conversationId, s); }
    return s;
  }

  private async exec(tool: string, args: Record<string, unknown>) {
    return this.tools.execute(tool as any, args, {
      root: this.root, safetyMode: "auto", task: this.makeDummyTask(),
      saveCheckpoint: async () => "", loadCheckpoint: async () => ({} as any)
    });
  }

  private makeDummyTask(): any {
    return {
      id: "agent", goal: "", root: this.root, plannerBackend: "chatgpt",
      safetyMode: "auto", status: "running", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), steps: [], changedFiles: [],
      verification: { sawGitDiff: false, sawVerification: false }
    };
  }

  private emit(event: AgentEvent): void { this.onEvent?.(event); }
}
