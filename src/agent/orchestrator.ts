import type { PlannerAdapter, PlannerSession } from "./types.js";
import { LocalToolRegistry } from "./tools.js";
import { MemoryStore } from "./memory.js";
import { loadProjectContext } from "./project-context.js";

export interface AgentEvent {
  type: "init" | "thinking" | "tool_call" | "tool_result" | "answer" | "error" | "step";
  data: unknown;
}
export type AgentEventCallback = (event: AgentEvent) => void;

/**
 * Our code drives the loop. ChatGPT is just a function we call.
 * 
 * Flow:
 *   1. Our code analyzes the task and gathers relevant files
 *   2. One ChatGPT call with everything it needs
 *   3. Our code extracts code blocks and writes them
 *   4. Our code verifies (diff, tests)
 *   5. If verification fails, one more ChatGPT call to fix
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
    const log: string[] = [];

    // Step 1: Gather context — OUR CODE decides what to read
    this.emit({ type: "init", data: "Analyzing task…" });
    const context = await this.gatherContext(userMessage, log);

    // Step 2: Call ChatGPT with focused context
    this.emit({ type: "step", data: { step: "🧠 Asking ChatGPT…" } });
    const session = await this.getSession(conversationId);
    const prompt = this.buildPrompt(userMessage, context);

    console.log("[agent] Prompt length:", prompt.length);
    const response = await this.chatgpt.sendTurn(session, prompt);

    if (!response.ok || !response.raw) {
      // Retry with fresh session
      this.sessions.delete(conversationId);
      const fresh = await this.getSession(conversationId);
      const retry = await this.chatgpt.sendTurn(fresh, prompt);
      if (!retry.ok || !retry.raw) {
        return log.length ? log.join("\n\n") + `\n\n⚠️ ${retry.message}` : `⚠️ ${retry.message}`;
      }
      return this.processResponse(retry.raw, userMessage, conversationId, log);
    }

    return this.processResponse(response.raw, userMessage, conversationId, log);
  }

  /**
   * Step 1: Our code gathers all relevant context before calling ChatGPT.
   */
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

    // Find relevant files based on the task
    const relevant = this.findRelevantFiles(task, files);
    
    // Read relevant files
    for (const f of relevant.slice(0, 6)) {
      this.emit({ type: "tool_call", data: { tool: "read_file", reason: `Reading ${f}` } });
      const result = await this.exec("read_file", { path: f });
      if (result.ok) {
        const content = (result.data as any)?.content ?? "";
        parts.push(`--- ${f} ---\n${content.slice(0, 5000)}`);
        log.push(`📖 Read \`${f}\``);
      }
    }

    // Search for task-related patterns if needed
    const searchTerms = this.extractSearchTerms(task);
    for (const term of searchTerms.slice(0, 2)) {
      this.emit({ type: "tool_call", data: { tool: "search", reason: `Searching: ${term}` } });
      const result = await this.exec("search", { pattern: term });
      if (result.ok) {
        const output = (result.data as any)?.stdout ?? "";
        if (output.trim()) {
          parts.push(`SEARCH "${term}":\n${output.slice(0, 2000)}`);
          log.push(`🔍 Searched \`${term}\``);
        }
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

  /**
   * Step 2: Build the ChatGPT prompt — context + task + output instructions.
   */
  private buildPrompt(task: string, context: string): string {
    return [
      "You are a coding assistant. I've gathered the project context for you below.",
      "",
      "INSTRUCTIONS:",
      "- Complete the task directly.",
      "- When writing/updating a file, output the COMPLETE file content in a code block tagged with the file path:",
      "  ```path/to/file.ext",
      "  complete file content here",
      "  ```",
      "- You can output multiple files if needed.",
      "- Be concise in explanations. Focus on the code.",
      "",
      `WORKSPACE: ${this.root}`,
      "",
      context,
      "",
      `TASK: ${task}`
    ].join("\n").slice(0, 40000);
  }

  /**
   * Step 3: Process ChatGPT's response — extract code blocks, write files, verify.
   */
  private async processResponse(response: string, task: string, conversationId: string, log: string[]): Promise<string> {
    console.log("[agent] Response length:", response.length);

    // Extract code blocks with file paths
    const writes = this.extractFileWrites(response);

    if (!writes.length) {
      // No files to write — this is just an answer
      return log.length ? log.join("\n\n") + "\n\n" + response : response;
    }

    // Write each file
    for (const { path, content } of writes) {
      this.emit({ type: "step", data: { step: `✍️ Writing ${path}` } });
      this.emit({ type: "tool_call", data: { tool: "write_file", reason: `Writing ${path}` } });
      const result = await this.exec("write_file", { path, content });

      if (result.ok) {
        log.push(`✅ Wrote \`${path}\``);

        // Get diff
        const diff = await this.exec("git_diff", { path });
        const diffText = (diff.data as any)?.stdout ?? "";
        if (diffText.trim()) {
          log.push(`\`\`\`diff\n${diffText.slice(0, 3000)}\n\`\`\``);
        }
      } else {
        log.push(`❌ Failed to write \`${path}\`: ${result.message}`);
      }
    }

    // Strip the code blocks from the response to get just the explanation
    let explanation = response;
    for (const { path } of writes) {
      // Remove the code block for this file from the explanation
      const regex = new RegExp("```" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n[\\s\\S]*?```", "g");
      explanation = explanation.replace(regex, "").trim();
    }

    // Combine log + explanation
    const finalParts = [...log];
    if (explanation.trim()) finalParts.push(explanation);
    return finalParts.join("\n\n");
  }

  /**
   * Find files relevant to the task based on keywords.
   */
  private findRelevantFiles(task: string, allFiles: string[]): string[] {
    const lower = task.toLowerCase();
    const relevant: string[] = [];

    // Direct file mentions in the task
    for (const f of allFiles) {
      const name = f.split("/").pop()?.toLowerCase() ?? "";
      if (lower.includes(name.replace(/\.\w+$/, "")) && name.includes(".")) {
        relevant.push(f);
      }
    }

    // Keyword-based matching
    const keywords: Record<string, string[]> = {
      "readme": ["README.md", "readme.md"],
      "package": ["package.json"],
      "config": ["tsconfig.json", ".chatgpt-agent.json"],
      "coupon": ["public/coupons.json"],
      "test": ["package.json"],
      "style": ["app/renderer/styles.css"],
      "html": ["app/renderer/index.html"],
      "electron": ["app/main.cjs", "app/preload.cjs", "app/chatgpt-bridge.cjs"],
      "agent": ["src/agent/orchestrator.ts", "src/agent/runtime.ts", "AGENT.md"],
      "bridge": ["src/bridge-server.ts", "app/chatgpt-bridge.cjs"],
      "api": ["src/api-server.ts"],
      "memory": ["src/agent/memory.ts"],
      "tool": ["src/agent/tools.ts"],
      "type": ["src/agent/types.ts"],
    };

    for (const [keyword, files] of Object.entries(keywords)) {
      if (lower.includes(keyword)) {
        for (const f of files) {
          if (allFiles.includes(f) && !relevant.includes(f)) relevant.push(f);
        }
      }
    }

    // Always include package.json for context
    if (!relevant.includes("package.json") && allFiles.includes("package.json")) {
      relevant.push("package.json");
    }

    return relevant;
  }

  /**
   * Extract search terms from the task for grep.
   */
  private extractSearchTerms(task: string): string[] {
    const terms: string[] = [];
    // Look for quoted strings
    const quoted = task.match(/"([^"]+)"|'([^']+)'/g);
    if (quoted) {
      for (const q of quoted) terms.push(q.replace(/['"]/g, ""));
    }
    // Look for specific identifiers (camelCase, snake_case)
    const identifiers = task.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/g);
    if (identifiers) {
      for (const id of identifiers.slice(0, 2)) terms.push(id);
    }
    return terms;
  }

  /**
   * Extract file writes from ChatGPT's response.
   * Looks for code blocks tagged with file paths: ```path/to/file.ext
   */
  private extractFileWrites(text: string): Array<{ path: string; content: string }> {
    const writes: Array<{ path: string; content: string }> = [];
    const regex = /```([\w./\\-]+\.[\w]{1,10})\n([\s\S]*?)```/g;
    const langTags = new Set([
      "json", "bash", "sh", "diff", "text", "txt", "md", "markdown",
      "javascript", "typescript", "ts", "js", "html", "css", "python",
      "py", "yaml", "yml", "xml", "sql", "plaintext", "shell", "zsh",
      "toml", "ini", "env", "log", "csv", "jsx", "tsx", "scss", "less",
      "rust", "go", "java", "c", "cpp", "ruby", "php", "swift", "kotlin"
    ]);

    let m;
    while ((m = regex.exec(text)) !== null) {
      const tag = m[1];
      const content = m[2];

      // Skip if it's just a language tag, not a file path
      if (langTags.has(tag.toLowerCase())) continue;

      // Must look like a file path (has / or starts with known dir or has extension with path-like chars)
      if (!tag.includes("/") && !tag.startsWith(".") && !tag.match(/^[\w-]+\.[\w]+$/)) continue;

      if (content.trim().length > 5) {
        writes.push({ path: tag, content });
      }
    }

    // Fallback: detect "filename.ext" on its own line followed by a code block
    if (!writes.length) {
      const fallbackRegex = new RegExp("^([\\w./\\\\-]+\\.[\\w]{1,10})\\s*\n```(?:\\w*)\n([\\s\\S]*?)```", "gm");
      let fm;
      while ((fm = fallbackRegex.exec(text)) !== null) {
        const tag = fm[1].trim();
        const content = fm[2];
        if (langTags.has(tag.toLowerCase())) continue;
        if (content.trim().length > 5) {
          writes.push({ path: tag, content });
        }
      }
    }

    // Fallback 2: if task mentions a specific file and response has one big code block, assume it is that file
    if (!writes.length) {
      const singleBlockRegex = new RegExp("```(?:markdown|md|json|ts|js|html|css)?\n([\\s\\S]{50,}?)```");
      const singleBlock = text.match(singleBlockRegex);
      if (singleBlock) {
        const beforeBlock = text.slice(0, text.indexOf(singleBlock[0]));
        const fileRef = beforeBlock.match(/([\w./\\-]+\.[\w]{1,10})/g);
        if (fileRef) {
          const lastFile = fileRef[fileRef.length - 1];
          if (!langTags.has(lastFile.toLowerCase()) && lastFile.includes(".")) {
            writes.push({ path: lastFile, content: singleBlock[1] });
          }
        }
      }
    }

    return writes;
  }

  private async getSession(conversationId: string): Promise<PlannerSession> {
    let session = this.sessions.get(conversationId);
    if (!session) {
      session = await this.chatgpt.startSession();
      this.sessions.set(conversationId, session);
    }
    return session;
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
