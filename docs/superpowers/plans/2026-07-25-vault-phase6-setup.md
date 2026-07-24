# Vault Phase 6 (Multi-Tool Setup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make onboarding a one-command, multi-tool experience: `vault setup` detects the AI tools installed on the machine (Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop, Windsurf), auto-discovers the user's projects from existing session transcripts, registers them, wires per-tool serving (compiled files + MCP), and fast-forwards mining. Plus the primitives it needs: GEMINI.md and .windsurfrules adapters, `vault compile --all`, and MCP server-level `instructions`.

**Architecture:** New `src/setup.ts` module driving detection and actions, wired as a CLI command with `--yes` (accept defaults, non-interactive) and `--dry-run` (print plan, change nothing). Project discovery reads `cwd` fields from real transcript files (never decodes directory names). Actions that touch OTHER apps' config files are conservative: JSON configs are edited idempotently with the original preserved keys; TOML (Codex) is never edited, only a ready-to-paste snippet is printed.

**Tech Stack:** Node built-ins only (readline for prompts). vitest with HOME-override sandboxing.

## Global Constraints

- Multi-tool is the product position (spec §11): nothing in setup may assume Claude Code is the only tool. Detection map: claude-code = `~/.claude` dir; codex = `~/.codex`; cursor = `~/.cursor`; gemini = `~/.gemini`; claude-desktop = `~/Library/Application Support/Claude`; windsurf = `~/.windsurf`. All paths via `os.homedir()` so tests can override HOME.
- Tool -> adapter mapping for compiled files: claude-code and claude-desktop -> `claude` (CLAUDE.md); codex -> `agents` (AGENTS.md); cursor -> `cursor` (.cursorrules); gemini -> `gemini` (GEMINI.md); windsurf -> `windsurf` (.windsurfrules).
- Project discovery NEVER decodes claude transcript directory names (lossy). It reads the `cwd` field from JSONL entries inside: for each dir under `~/.claude/projects/`, open the newest `*.jsonl`, scan up to the first 50 lines for a `cwd`. For Codex: open the newest few `~/.codex/sessions/**/*.jsonl` files and look for a `cwd` field in the first lines of each; if the format carries none, skip the codex source silently (inspect the real format during implementation; do not guess).
- Discovered project filter: cwd must exist on disk, must not equal the home dir itself, dedupe by realpath, drop cwds already covered by a registered project root.
- Never clobber: settings/config edits are read-parse-merge-write with all unknown keys preserved; every edited config gets a one-time `.bak-vault` sibling copy on first edit. TOML is print-only. Compiled files keep the existing not-generated safety skip.
- `--yes` = accept all defaults without prompting (CI/tests); `--dry-run` = print what would happen, write nothing. Without either, prompt per action group (y/n via readline).
- Mining stays opt-in for cost reasons: setup runs `mine --from-now` (free) and PRINTS how to enable the daily mining daemon; it never loads it.
- The refresh daemon (`vault compile --all` on a schedule) is free/local, so setup MAY install and load a launchd agent `dev.vault.refresh` (hourly) when the user says yes; on non-darwin, print a cron line instead.
- NO em/en dashes. Commit messages: technical, never reference AI/Claude/assistant, no co-author trailers. README factual.

---

## File Structure

```
src/adapters/gemini.ts     # GEMINI.md
src/adapters/windsurf.ts   # .windsurfrules
src/adapters/index.ts      # registry + mapping export
src/mcp.ts                 # server-level instructions
src/cli.ts                 # compile --all, setup command
src/setup.ts               # detection, discovery, actions (pure functions + runSetup)
tests/setup.test.ts        # HOME-sandboxed wizard tests
tests/adapters.test.ts     # + new adapters
tests/cli.test.ts          # + compile --all
tests/mcp.test.ts          # + instructions assertion
```

---

### Task 1: New adapters + compile --all + MCP instructions

**Files:**
- Create: `src/adapters/gemini.ts`, `src/adapters/windsurf.ts`
- Modify: `src/adapters/index.ts` (registry + `TOOL_ADAPTERS` map), `src/cli.ts` (compile `--all`), `src/mcp.ts` (instructions), tests listed above

**Interfaces:**
- Produces:
  - `gemini: Adapter` (`filename: 'GEMINI.md'`, markdown render identical to claude/agents incl. GENERATED_HEADER + MCP_HINT)
  - `windsurf: Adapter` (`filename: '.windsurfrules'`, text render identical to cursor incl. MCP_HINT)
  - `adapters` registry gains keys `gemini`, `windsurf`
  - `export const TOOL_ADAPTERS: Record<string, string> = { 'claude-code': 'claude', 'claude-desktop': 'claude', codex: 'agents', cursor: 'cursor', gemini: 'gemini', windsurf: 'windsurf' }` in adapters/index.ts
  - CLI: `vault compile --all [--tool <list>] [--force]`: for EVERY project that has at least one `path` root whose dir exists, compile into that root (first existing path root) with the selected tools; per-file safety skip unchanged; prints one line per file plus a summary `compiled N projects, skipped M files`; `--all` conflicts with `--project`/`--out` (clean error). Without `--all` behavior is unchanged.
  - `src/mcp.ts` `buildServer`: pass server-level instructions to the McpServer constructor (second argument options object, `instructions:` field per the installed SDK 1.29 API; verify the exact signature in node_modules and adapt): text (verbatim): `This server is the user's portable memory vault. Call get_context once at the start of every conversation to learn who the user is and what they are working on. When the user states a durable fact, decision, recipe or preference, save it with remember. Records you save stay pending until the user confirms them.`

**Tests (normative additions):**
- adapters.test.ts: registry keys now `['agents','claude','cursor','gemini','windsurf']` sorted; gemini render contains GENERATED + a known ctx string; windsurf render starts with the text header line; both contain `call get_context`.
- cli.test.ts: `compile --all` test: two projects with tmp roots + one project without roots; run `vault compile --all --tool claude`; assert CLAUDE.md exists in both roots, summary line mentions 2 projects; assert `compile --all --project x` exits 1.
- mcp.test.ts: after initialize, `init.result.instructions` contains 'get_context' (adapt assertion to where the SDK surfaces it; if the SDK exposes instructions only via the InitializeResult field `instructions`, assert exactly that).

- [ ] Steps: TDD (failing tests first), implement, focused tests, FULL suite, `npx tsc --noEmit`, commit:
```bash
git add -A && git commit -m "Add gemini and windsurf adapters, compile --all and MCP server instructions"
```

---

### Task 2: `vault setup` wizard

**Files:**
- Create: `src/setup.ts`, `tests/setup.test.ts`
- Modify: `src/cli.ts` (setup command), `README.md` (Quickstart rewritten around `vault setup`, multi-tool)

**Interfaces (src/setup.ts, all exported for tests):**
- `detectTools(home: string): string[]` - subset of ['claude-code','codex','cursor','gemini','claude-desktop','windsurf'] by dir existence (constraint map above).
- `discoverProjects(home: string): { cwd: string; source: string }[]` - claude transcript scan (+ codex if its format carries cwd), filtered per Global Constraints.
- `interface SetupPlan { vaultDir: string; tools: string[]; newProjects: { cwd: string; name: string }[]; adapters: string[] }`
- `buildPlan(home: string, vaultDir: string): SetupPlan` - name = basename of cwd; adapters = unique TOOL_ADAPTERS values for detected tools (always include 'claude' when claude-code present).
- `runSetup(opts: { home: string; vaultDir: string; yes: boolean; dryRun: boolean; ask: (q: string) => Promise<boolean> }): Promise<void>` - executes the plan in this order, each group gated by ask()/yes:
  1. `initVault` if not present (print "vault exists" otherwise).
  2. Register each new project (`createProject` with `{path: cwd}` root, kind 'code').
  3. Claude Code detected: idempotently add the SessionStart hook (`<vault bin> compile --tool claude >/dev/null 2>&1 || true`, timeout 15) to `<home>/.claude/settings.json` preserving all other keys (create file with just the hook if missing); back up once to `settings.json.bak-vault`. Print the `claude mcp add vault -- vault mcp` one-liner (do not run it: it needs the claude CLI and user context).
  4. Claude Desktop detected: idempotently merge `mcpServers.vault = { command: <vault bin>, args: ['mcp'] }` into `<home>/Library/Application Support/Claude/claude_desktop_config.json` (create if missing, `.bak-vault` once).
  5. Cursor detected: same merge into `<home>/.cursor/mcp.json`.
  6. Codex detected: PRINT the config.toml snippet (`[mcp_servers.vault]\ncommand = "<vault bin>"\nargs = ["mcp"]`), never edit TOML.
  7. `mine --from-now` semantics inline (fast-forward offsets over `~/.claude/projects`), print the launchctl line for the optional mining daemon without loading anything.
  8. darwin only: offer the refresh daemon: write `<home>/Library/LaunchAgents/dev.vault.refresh.plist` running `<vault bin> compile --all` hourly (StartInterval 3600) and `launchctl load` it. In tests (fake HOME) write the plist but SKIP the launchctl call when env `VAULT_SETUP_NO_LAUNCHCTL` is set.
  9. Final: compile --all with the plan's adapters; print a summary of everything done and the two manual follow-ups (claude mcp add line, codex snippet).
  - `<vault bin>` = `process.execPath`? No: resolve the CLI entry as `process.argv[1]` is tsx in dev; use the stable form: prefer an existing `vault` on PATH (`which vault` via spawnSync), fall back to `node <resolved dist/cli.js>`. Encapsulate as `vaultBin(): string` and keep it testable.
- CLI: `vault setup [--yes] [--dry-run]` wiring `ask` to readline y/n prompts (default yes on empty input); `--yes` skips prompting entirely; keep the existing top-level error handling style.

**Tests (tests/setup.test.ts, all with `HOME` pointed at a fabricated tmp home; spawn the CLI with `env: { ...process.env, HOME: fakeHome, VAULT_DIR: <tmp vault>, VAULT_SETUP_NO_LAUNCHCTL: '1' }`):**
1. Fabricate `<home>/.claude/projects/-x-work/s.jsonl` whose entries carry `cwd: <tmp work dir that exists>`, plus `<home>/.codex` and `<home>/.cursor` dirs. `vault setup --yes` then assert: vault created; project registered with the work dir root (project list contains basename); `<home>/.claude/settings.json` contains the SessionStart hook; `<home>/.cursor/mcp.json` has mcpServers.vault; offsets file fast-forwarded (>0 for the fabricated transcript); compiled file exists in the work dir for every planned adapter (CLAUDE.md + AGENTS.md is NOT expected since codex maps to agents - it IS expected: `.codex` dir was fabricated, so agents adapter is in the plan; assert CLAUDE.md, AGENTS.md and .cursorrules all exist in the work root); plist file written.
2. Idempotence: run `vault setup --yes` a second time; assert no duplicate hook entries in settings.json, no duplicate project registration (project list length unchanged), exit 0.
3. Preservation: pre-seed `<home>/.claude/settings.json` with `{"model":"x","hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}`; after setup both the original hook and model survive alongside the new SessionStart entry, and `settings.json.bak-vault` exists.
4. `--dry-run`: fabricate the same home; assert NOTHING was created (no vault dir content beyond what existed, no settings.json change) and stdout lists the planned actions.
5. `discoverProjects` unit: transcript with cwd pointing at a non-existent dir is dropped; cwd equal to home is dropped; two transcripts with the same cwd dedupe to one.

- [ ] Steps: TDD, implement, focused tests, FULL suite, `npx tsc --noEmit` + `npm run build`, README Quickstart update (npm i -g placeholder name, `vault setup`, what it detects per tool, manual snippets for codex), commit:
```bash
git add -A && git commit -m "Add multi-tool setup wizard with project discovery and per-tool wiring"
```

---

## Self-Review Notes

- Multi-tool parity: every detected tool gets its native file format; MCP wiring covered for Claude Code (print), Claude Desktop (merge), Cursor (merge), Codex (print snippet); Gemini CLI reads GEMINI.md (no MCP wiring attempted v1).
- Codex mining reader is intentionally NOT in this phase (spec §6 roadmap: second reader); setup only fast-forwards the claude reader.
- The refresh daemon is free (local compile), so it may be installed by the wizard; the mining daemon costs money, so it is never auto-enabled.
