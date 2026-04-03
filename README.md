## ChatGPT Web Wrapper

Use your live ChatGPT tab as the planning brain while the local agent runs the tools, edits files, and keeps a Codex-style terminal shell humming. There are two entry points:

1. **Extension bridge (current focus)**: runs inside your real Chrome profile via a content script + local HTTP bridge — no headless browsers, no Playwright UI automation, just messages over a WebSocket.  
2. **Playwright automation**: spins up a chromium session (or attaches to one) and drives the ChatGPT UI directly when you need a pure automation fallback.

Both sit on the same toolset, but the bridge is far more stable for daily work. It does depend on the ChatGPT DOM selectors used in `extension/content.js`, so update those if the UI changes.

## Bridge Quickstart (preferred)

```bash
npm run bridge:server
npm run agent:tui
```

- The bridge server exposes `/health`, `/messages`, `/send`, `/last-assistant`, and `/new-chat`.
- Load `extension/` via `chrome://extensions` in Developer mode to link your real ChatGPT tab to that server.
- The `agent:tui` script opens the Codex-like dashboard with sessions, planner history, changed files, and diff/verification panes.

## Agent workflow overview

1. Tell the agent a goal (e.g., `:start "Write a LinkedIn update about our autonomous agent"`).  
2. AgentRuntime builds a prompt with repo context, tool schema, and safety policy, then sends it to ChatGPT through the bridge.  
3. ChatGPT replies with one structured tool call (tool + args + reason) or `{"type":"done",...}`.  
4. Local tool registry executes the action (`read_file`, `apply_patch`, `remember_text`, etc.) and feeds the result back into the loop.  
5. Repeat until ChatGPT returns `done`, after which the task finalizes with diffs/verification stored in `.agent-state/`.

## Tools at a glance

- Reading & search: `list_files`, `read_file`, `read_file_range`, `read_multiple_files`, `file_metadata`, `summarize_file`, `search`.  
- Writing & patching: `write_file`, `replace_text`, `insert_text`, `apply_patch`, plus the new `remember_text` helper that captures planner prose and optionally writes it to disk.  
- Shell/git: `run_command`, `run_tests`, `run_build`, `run_lint`, `run_format_check`, `git_status`, `git_diff`, `git_diff_cached`, `git_show`.  
- Task helpers: `task_checkpoint_save`, `task_checkpoint_load`.

Use `remember_text` for prose-heavy outputs like LinkedIn posts so the TUI shows the generated copy and, if requested, saves it (`path` argument) with the agent keeping the path on the task summary.

## TUI commands (persistent Codex console)

- `:start <goal>` – spawn a new task with the provided goal (auto-saves under `.agent-state/<id>`).  
- `:resume <task-id>` – reopen a paused or completed session.  
- `:abort <task-id>` – stop a running task cleanly.  
- `:refresh` – reload session list/state from disk.  
- `:quit` / `q` / `Ctrl+C` – exit the UI.  

The UI panels show:

- **Sessions (left)**: real-time task list with status/goal and selectable history.  
- **Summary (top-right)**: goal, planner backend, step count, latest output preview, and saved file path when available.  
- **History (middle-right)**: planner messages, tool arguments/results, system events, and the `remember_text` output rendered immediately.  
- **Files + Diff (bottom-right)**: changed files list plus the latest `git diff` snapshot and verification flags.

Want a CLI spin instead? Use `npm run agent -- start "<goal>"` for the shorthand dashboard or `--tui`/`--no-tui` flags to force behavior.

## Configuration

Drop a `.chatgpt-agent.json` at repo root to tweak prompts and hooks:

```json
{
  "compaction": {
    "keepRecentSteps": 8,
    "maxPromptChars": 30000
  },
  "hooks": {
    "beforeTool": [
      "echo \"running $AGENT_TOOL_NAME for $AGENT_TASK_ID\""
    ],
    "onTaskComplete": [
      "echo \"task $AGENT_TASK_ID finished with status $AGENT_TASK_STATUS\""
    ]
  }
}
```

Supported keys: `compaction.keepRecentSteps`, `compaction.maxPromptChars`, `hooks.onTaskStart`, `hooks.onTaskComplete`, `hooks.beforeTool`, `hooks.afterTool`.

## Limitations & UX notes

- One tool call per planner reply keeps the loop predictable.  
- `apply_patch` uses a unified diff parser (multi-file adds allowed, deletes/renames blocked).  
- `write_file` simply overwrites the target, so use `apply_patch` for surgical edits.  
- `remember_text` gives prose a home; ask for `path` to persist it.  
- Safety modes: `auto` (default), `guarded`, `read_only`.  
- The extension bridge relies on DOM selectors in `extension/content.js`; update them if ChatGPT’s UI changes.  
- CLI mode still uses the bridge; Playwright automation is the only route that actively drives the UI (see below).

## Legacy Playwright mode

Use this when you specifically want to drive the UI or can’t install the extension. It opens a Chromium session (or attaches to one) and types into the ChatGPT composer directly.

```bash
npm install
npx playwright install chromium
npm run chat -- "Say hello in one sentence"
```

On first run Chrome opens and you may need to log in. Your session stores under `.auth/chatgpt`. Kernel/hot note: DOM changes, CAPTCHAs, and plan-gating still bite this flow.

Want to attach to an already open Chrome instance?

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222
export CHROME_CDP_URL="http://127.0.0.1:9222"
npm run chrome:attach -- "Summarize my last visible conversation"
```

This still depends on Chrome being launched with `--remote-debugging-port` and may open a new tab to ChatGPT with the Playwright-controlled window.

## API recap

`ChatGPTWebWrapper` (Playwright path) exposes:

- `start()` – launch the browser.  
- `ensureReady()` – wait for composer.  
- `sendMessage(text)` – type + submit.  
- `waitForAssistantResponse()` – wait for the latest assistant message.  
- `readMessages()` / `getLastMessage(role?)` – inspect visible conversation.  
- `gotoNewChat()` – open a new chat.  
- `close()` – tear down the browser.

Options include `headless`, `userDataDir` (default `.auth/chatgpt`), `browserChannel`, `profileDirectory`, `cdpUrl`, `chatUrl`, and `timeoutMs`.

## Final word

This repo now centers around the bridge-powered, ChatGPT-as-brain agent with a full persistent TUI. Treat it as your autonomous coding partner — it keeps planner state, polls tools, displays outputs, and lets you capture prose plus files in one session. Playwright remains as backup automation when you can’t touch the extension.
