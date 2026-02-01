# LSP MCP Rules

Best practices for agents using the unified lsp-mcp server (Python + TypeScript + Vue).

## 1. Single Active Workspace Rule

**You must set the workspace before accessing any files.**

```
switch_workspace("/Users/treedy/Project/MyRepo")
```

- **Why?** LSP backends are stateful. They need to know the project root to resolve imports (`from . import utils`) and configurations (`tsconfig.json`).
- **When?**
    - Start of session.
    - When moving from one project to another (e.g., `backend` to `frontend`).
- **Error:** If you see `"Context Mismatch"`, you are trying to access a file outside the active workspace. **Stop and switch workspace.**

## 2. Resource Efficiency

**LSP operations are expensive. Don't spam them.**

- **Bad**: `read_file("large_file.ts")` just to check one function signature.
- **Good**: `hover("large_file.ts", line, col)` to see the signature.
- **Why?** Reading large files consumes context window tokens. `hover` is surgical and cheap.

## 3. Path Handling

- **Relative Paths**: Once workspace is set, prefer relative paths (`src/main.ts`) over absolute paths. It saves tokens and is easier to read.
- **Absolute Paths**: Only use when setting the initial workspace.

## 4. Workflow: The "Safe Edit" Cycle

1.  **Diagnose**: Run `diagnostics(".")` to ensure the codebase is clean *before* you touch it.
2.  **Explore**: Use `symbols` and `hover` to understand the code you are about to change.
3.  **Edit**: Perform your changes (using standard edit tools or `rename`/`move`).
4.  **Verify**: Run `diagnostics(".")` again. **If new errors appear, you must fix them.**

## 5. Tool Selection Guide

| Task | Tool | Note |
|---|---|---|
| "What is this symbol?" | `hover` | Best for quick docs |
| "Where is it defined?" | `definition` | Jumps to source |
| "Where is it used?" | `references` | Essential before renaming |
| "What's in this file?" | `symbols` | Outline view |
| "Are there errors?" | `diagnostics` | **Mandatory** check |
| "Global Search" | `search` | Regex based |
| "Refactor" | `rename` | Safe & atomic |

## 6. Language-Specific Features

- **Python**: Supports advanced refactoring like `python_move` and `python_change_signature`.
- **TypeScript**: Supports `typescript_available_refactors` (Code Actions).
- **Vue**: Supports `.vue` files via Volar. Use standard tools (`hover`, `definition`) on `.vue` files just like `.ts` files.

## 7. Error Recovery

If a tool fails with "Internal Error" or "Timeout":
1.  Check if `switch_workspace` was called correctly.
2.  Check if the file path exists.
3.  If persistent, try `reload_config()` to reset state.