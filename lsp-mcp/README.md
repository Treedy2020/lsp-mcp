# @treedy/lsp-mcp

One MCP server for Python, TypeScript/JavaScript, and Vue code intelligence.

It pre-registers unified LSP tools (`hover`, `definition`, `diagnostics`, etc.), auto-detects language from file path, and auto-starts backends on first use.

By default, published builds are lean: they do not include bundled backend runtime payloads.
Backends are resolved on-demand via `npx` / `uvx`.

## 60-Second Setup

1) Add to your MCP client config:

```json
{
  "mcpServers": {
    "lsp-mcp": {
      "command": "npx",
      "args": ["@treedy/lsp-mcp@latest"]
    }
  }
}
```

2) Try these first calls:

```txt
status
list_backends
hover file=/abs/path/to/file.py line=10 column=5
diagnostics path=/abs/path/to/project
git_diagnostics
```

`start_backend` is optional now. Backends are started automatically when a tool needs them.

## What You Get

- Unified tools across languages: `hover`, `definition`, `references`, `search`, `diagnostics`, `rename`, etc.
- Language-specific refactor tools where needed:
  - Python: `python_move`, `python_change_signature`, `python_function_signature`
  - TypeScript: `typescript_move`, `typescript_function_signature`
- Meta/admin tools: `status`, `list_backends`, `check_versions`, `update_backend`, `reload_config`, `switch_workspace`, `switch_workspace_for_language`, `discover_language_workspaces`, `semantic_session_start`, `doctor`, `expand_result`
- Built-in prompts for agent workflows and best practices

## Tool Model (Current)

### Unified tools (preferred)

Use these directly; language is inferred from file/path:

- Navigation: `hover`, `definition`, `implementation`, `type_definition`, `call_hierarchy`, `type_hierarchy`, `document_highlight`, `selection_range`, `folding_range`, `document_link`, `linked_editing_range`, `semantic_tokens`, `moniker`, `references`, `peek_definition`, `workspace_symbol`
- Hinting: `inlay_hints`, `inlay_hint_resolve`, `read_file_with_hints`
- Composite semantic workflow: `semantic_navigate` (optional search -> definition -> references -> read_file_with_hints)
- Editing support: `completions`, `signature_help`, `prepare_rename`, `rename`, `code_action`, `run_code_action`, `code_lens`
- Analysis: `diagnostics`, `git_diagnostics`, `symbols`, `search`, `summarize_file`, `read_file_with_hints`, `project_structure`
- Sync/edit loop: `update_document`

Compatibility aliases are also available for older clients, for example:
`python_hover`, `typescript_definition`, `python_diagnostics`.

### High-volume output controls

For large repos, use preview arguments to reduce token usage:

- `search` / `workspace_symbol`: `preview_limit` or `page_size` (default `200`), plus `cursor` for next page
- `diagnostics`: `preview_limit` or `page_size` (default `200`), `summary_only` (default `false`), plus `cursor`
- `doctor`: `page_size` (default `50`) plus `cursor` for long environment reports
- `doctor`: set `check_latest_versions=true` to probe registry latest version drift (slower, network-dependent)
- Strict semantic errors include `recovery_plan` and standard cost fields: `latency_ms`, `result_size`, `truncated`, `cursor_available`
- `project_structure`: `max_depth` (default `3`), `max_entries` (default `300`)
- `summarize_file`: `max_symbols` (default `200`)
- `read_file_with_hints`: `start_line` (default `1`), `max_lines` (default `300`)
- `project_structure` / `summarize_file` / `read_file_with_hints`: also support `page_size` + `cursor`

Paged responses include:
- `page`: `{ shown, offset, page_size, has_more, next_cursor }`
- `next`: ready-to-call arguments for the next page (via `expand_result`)
- Cursors are signed and expire automatically (TTL-based) for safer paging.

### Language-specific tools

- Python-only: `python_move`, `python_change_signature`, `python_function_signature`
- TypeScript-only: `typescript_move`, `typescript_function_signature`

### Server/meta tools

- `status`, `list_backends`, `start_backend`, `update_backend`, `check_versions`, `reload_config`, `switch_python_backend`, `switch_workspace`, `switch_workspace_for_language`, `discover_language_workspaces`, `semantic_session_start`, `doctor`, `expand_result`
- `discover_language_workspaces` input: `root` (optional), `max_depth` (optional, default `2`), `apply` (optional, default `false`)
- `semantic_session_start` input: `language` (optional), `workspace` (optional), `file` (optional), `start_backend` (optional, default `true`)
- In mixed-language monorepos, semantic tools require language workspace mapping (set via `switch_workspace_for_language` or `discover_language_workspaces(..., apply=true)`).
- `doctor` now includes `workspaceDependencyChecks.language_workspace_discovery` with suggested per-language workspace commands.
- `doctor` includes `backendPackageDrift` to show installed backend version vs latest policy and upgrade next steps.
- `doctor` includes `backendVersionSummary` (stable schema with `schema_version`, `counts`, `by_language`, `lookup_stats`) for quick LLM triage.

Example fields exposed for client/LLM orchestration:

```json
{
  "backend_runtime_mode": "registry",
  "backend_packages": [
    {
      "language": "typescript",
      "package": "@treedy/typescript-lsp-mcp",
      "package_ref": "@treedy/typescript-lsp-mcp@latest",
      "registry": "npm",
      "resolver": "npx",
      "provider": "typescript-lsp-mcp",
      "install_command": "npx --yes @treedy/typescript-lsp-mcp@latest",
      "update_command": "npx --yes @treedy/typescript-lsp-mcp@latest",
      "default_channel": "latest",
      "auto_update_enabled": true,
      "minimum_supported_version": "0.1.0"
    }
  ],
  "backendPackageDrift": {
    "typescript": {
      "installed_version": "0.2.0",
      "minimum_supported_version": "0.1.0",
      "minimum_status": "supported",
      "drift_status": "policy_aligned",
      "latest_registry_version": "0.2.0",
      "latest_status": "up_to_date",
      "next_step": "No action needed.",
      "latest_next_step": "Installed version matches latest policy."
    }
  },
  "backendVersionSummary": {
    "schema_version": 1,
    "check_latest_versions": true,
    "lookup_stats": {
      "schema_version": 1,
      "enabled": true,
      "cache_ttl_ms": 300000,
      "requested": 3,
      "cache_hits": 2,
      "inflight_hits": 0,
      "executed": 1,
      "succeeded": 1,
      "failed": 0,
      "skipped": 0
    },
    "counts": {
      "languages": 3,
      "below_minimum": 0,
      "outdated": 0,
      "policy_drift": 0,
      "bundled_static": 0,
      "unknown_latest": 0
    }
  }
}
```

## Prompts (Skills)

- `code-navigation`
- `refactoring`
- `code-analysis`
- `lsp-rules`
- `explore-project`
- `debug-file`
- `lsp-quick-start`

## Configuration

You can configure with env vars or `.lsp-mcp.json` in your workspace.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LSP_MCP_PYTHON_ENABLED` | `true` | Enable Python backend |
| `LSP_MCP_PYTHON_PROVIDER` | `python-lsp-mcp` | Python provider (`python-lsp-mcp` or `pyright-mcp`) |
| `LSP_MCP_TYPESCRIPT_ENABLED` | `true` | Enable TypeScript backend |
| `LSP_MCP_VUE_ENABLED` | `true` | Enable Vue backend |
| `LSP_MCP_AUTO_UPDATE` | `true` | Update backend packages to latest on startup/update |
| `LSP_MCP_BACKEND_RUNTIME_MODE` | `registry` | Backend runtime strategy: `registry` (default), `auto`, `bundled` |
| `LSP_MCP_REQUIRE_BUNDLED_BACKENDS` | `false` | Legacy strict bundled mode (equivalent to runtime mode `bundled`) |
| `LSP_MCP_EAGER_START` | `false` | Start all enabled backends when server boots |
| `LSP_MCP_IDLE_TIMEOUT` | `600` | Backend idle timeout in seconds |

### Auto-update behavior

When `LSP_MCP_AUTO_UPDATE=true`:

- `python-lsp-mcp` via `uvx --upgrade python-lsp-mcp`
- `pyright-mcp` via `npx --yes @treedy/pyright-mcp@latest`
- `typescript-lsp-mcp` via `npx --yes @treedy/typescript-lsp-mcp@latest`
- `vue-lsp-mcp` via `npx --yes @treedy/vue-lsp-mcp@latest`

### Runtime dependency expectations

- Lean mode (default): backend packages are fetched when first used (`LSP_MCP_BACKEND_RUNTIME_MODE=registry`).
- Bundled mode: set `LSP_MCP_BACKEND_RUNTIME_MODE=bundled` or `LSP_MCP_REQUIRE_BUNDLED_BACKENDS=true`.
- Required host tools:
  - TypeScript/Vue/Pyright backends: `node` + `npx`
  - Python backend: `uv` (or `uvx`)
- Vue semantic features additionally require project-local deps in the Vue workspace:
  - `typescript`
  - `@vue/language-server`
- Use `doctor` to get structured dependency checks and install commands.

## Better Out-of-Box Experience (Recommended)

- Use absolute file paths for the first calls to avoid inference edge cases.
- Call `switch_workspace path=/abs/project/root` to set the global root for non-semantic flows (search, project exploration).
- For semantic tools (hover/definition/references/diagnostics), set per-language roots via `switch_workspace_for_language` or `discover_language_workspaces(..., apply=true)`.
- For mixed-language repos, prefer `git_diagnostics` before broad `diagnostics path=.`
- If startup speed matters, set `LSP_MCP_EAGER_START=true`.

## Development

```bash
# Install deps
bun install

# Build local dist/ (lean default, no bundled backends)
bun run build

# Build local dist/ + bundled backends (for offline/dev integration runs)
bun run build:bundled

# Run in watch mode
bun run dev

# Full integration suite (builds bundled mode first)
bun run test

# Benchmark-focused suite (zod + fastapi + vitesse)
bun run test:benchmark

# Reporting template for benchmark runs
# docs/techbet-report-template.md

# Legacy smoke script (kept for low-level checks)
bun run test:legacy

# Prompt integration tests
bun test test/integration/prompts.test.ts

# Manual inspection
bun run inspector
```

## License

MIT
