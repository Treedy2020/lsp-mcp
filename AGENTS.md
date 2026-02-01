# Repository Guidelines

## Project Structure & Module Organization
This repo hosts a unified MCP server plus language-specific backends.
- `lsp-mcp/`: Unified TypeScript server (Bun, ESM) and meta tools.
- `backends/python/python-lsp-mcp/`: Python server (Rope + Pyright) with `src/rope_mcp/` and `tests/`.
- `backends/python/pyright-mcp/`: TypeScript implementation of Pyright MCP.
- `backends/typescript/typescript-lsp-mcp/`: TypeScript/JavaScript backend.
- `backends/vue/`: Vue-specific backend and vendored language tools.
- `docs/` and `skills/`: Documentation and agent guidance.

## Build, Test, and Development Commands
- Unified server:
  - Build: `cd lsp-mcp && bun run build`
  - Dev watch: `cd lsp-mcp && bun --watch src/index.ts`
  - Tests: `cd lsp-mcp && bun run test`
- Python backend:
  - Tests: `cd backends/python/python-lsp-mcp && uv run pytest tests/ -v`
  - Run locally: `cd backends/python/python-lsp-mcp && uv run python-lsp-mcp`
- Pyright MCP (TS):
  - Build: `cd backends/python/pyright-mcp && bun run build`
  - Tests: `cd backends/python/pyright-mcp && bun run test:mcp`
- TypeScript MCP:
  - Build: `cd backends/typescript/typescript-lsp-mcp && bun run build`
  - Tests: `cd backends/typescript/typescript-lsp-mcp && bun run test`
- Vue language tools (if touched): `cd backends/vue/language-tools && npm run lint` and `npm run format`

## Coding Style & Naming Conventions
- TypeScript packages are ESM; keep tool schemas and routing patterns consistent with `lsp-mcp/src/`.
- Python code uses 4-space indentation and `snake_case` modules/functions under `src/rope_mcp/`.
- Prefer existing naming patterns (e.g., `*-mcp` package names, `tools/` for tool handlers).

## Testing Guidelines
- Use the package-local test runners above; add/extend tests alongside the package you change.
- Pytest tests live in `backends/python/python-lsp-mcp/tests/`.
- Bun tests live under each TS package’s `test/` folder.
- No explicit coverage target is enforced; add tests for new tools or behavior changes.

## Commit & Pull Request Guidelines
- Commit messages are short, sentence-case statements (no scopes/prefixes), e.g., “Fix version reporting”.
- PRs should include: a brief summary, relevant commands run, and any config/tooling changes.
- If you add or change MCP tools, document the new tool names and expected inputs/outputs in the relevant README.

## Security & Configuration Tips
- Backend behavior is often controlled by env vars (see root `README.md`); mention new flags in docs.
- Avoid committing workspace caches such as `.ropeproject/`.
