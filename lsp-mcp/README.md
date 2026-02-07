# @treedy/lsp-mcp

One MCP server for Python, TypeScript/JavaScript, and Vue code intelligence.

It pre-registers unified LSP tools (`hover`, `definition`, `diagnostics`, etc.), auto-detects language from file path, and auto-starts backends on first use.

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
- Meta/admin tools: `status`, `list_backends`, `check_versions`, `update_backend`, `reload_config`, `switch_workspace`, `switch_workspace_for_language`, `discover_language_workspaces`, `doctor`, `expand_result`
- Built-in prompts for agent workflows and best practices

## Tool Model (Current)

### Unified tools (preferred)

Use these directly; language is inferred from file/path:

- Navigation: `hover`, `definition`, `references`, `peek_definition`, `workspace_symbol`
- Editing support: `completions`, `signature_help`, `rename`, `code_action`, `run_code_action`
- Analysis: `diagnostics`, `git_diagnostics`, `symbols`, `search`, `summarize_file`, `read_file_with_hints`, `project_structure`
- Sync/edit loop: `update_document`

Compatibility aliases are also available for older clients, for example:
`python_hover`, `typescript_definition`, `python_diagnostics`.

### High-volume output controls

For large repos, use preview arguments to reduce token usage:

- `search` / `workspace_symbol`: `preview_limit` or `page_size` (default `200`), plus `cursor` for next page
- `diagnostics`: `preview_limit` or `page_size` (default `200`), `summary_only` (default `false`), plus `cursor`
- `doctor`: `page_size` (default `50`) plus `cursor` for long environment reports
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

- `status`, `list_backends`, `start_backend`, `update_backend`, `check_versions`, `reload_config`, `switch_python_backend`, `switch_workspace`, `switch_workspace_for_language`, `discover_language_workspaces`, `doctor`, `expand_result`
- `discover_language_workspaces` input: `root` (optional), `max_depth` (optional, default `2`), `apply` (optional, default `false`)
- In mixed-language monorepos, semantic tools require language workspace mapping (set via `switch_workspace_for_language` or `discover_language_workspaces(..., apply=true)`).
- `doctor` now includes `workspaceDependencyChecks.language_workspace_discovery` with suggested per-language workspace commands.

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
| `LSP_MCP_EAGER_START` | `false` | Start all enabled backends when server boots |
| `LSP_MCP_IDLE_TIMEOUT` | `600` | Backend idle timeout in seconds |

### Auto-update behavior

When `LSP_MCP_AUTO_UPDATE=true`:

- `python-lsp-mcp` via `uvx --upgrade python-lsp-mcp`
- `pyright-mcp` via `npx --yes @treedy/pyright-mcp@latest`
- `typescript-lsp-mcp` via `npx --yes @treedy/typescript-lsp-mcp@latest`
- `vue-lsp-mcp` via `npx --yes @treedy/vue-lsp-mcp@latest`

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

# Build local dist/ + bundled backends
bun run build

# Run in watch mode
bun run dev

# Full integration suite (builds first, uses local dist/bundled)
bun run test

# Benchmark-focused suite (zod + fastapi + vitesse)
bun run test:benchmark

# Legacy smoke script (kept for low-level checks)
bun run test:legacy

# Prompt integration tests
bun test test/integration/prompts.test.ts

# Manual inspection
bun run inspector
```

## License

MIT
