# Claude Code Integration

Rules and patterns for using python-lsp-mcp with Claude Code.

## MCP Configuration

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "python-lsp": {
      "command": "uvx",
      "args": ["python-lsp-mcp"]
    }
  }
}
```

Or with Pyright backend:

```json
{
  "mcpServers": {
    "python-lsp": {
      "command": "uvx",
      "args": ["python-lsp-mcp"],
      "env": {
        "PYTHON_LSP_MCP_BACKEND": "pyright"
      }
    }
  }
}
```

## CLAUDE.md Rules

Add these rules to your project's `CLAUDE.md`:

```markdown
## Python Code Intelligence

When working with Python code:

1. **Before modifying code**, use `hover()` to understand types
2. **For renaming symbols**, use `rename()` instead of manual search-replace
3. **For moving code**, use `move()` to handle import updates
4. **For changing function parameters**, use `change_signature()`
5. **After refactoring**, run `diagnostics()` to verify no type errors

### Tool Priority

- Use `hover()` before reading files to get type info
- Use `definition()` to find where symbols are defined
- Use `references()` before renaming to understand impact
- Use `symbols()` to quickly understand file structure
```

## Common Workflows

### Workflow: Rename a Function

```
User: Rename get_user to fetch_user

Claude:
1. [references(file, line, col)] → See all usages
2. "Found 5 usages across 3 files. Proceeding with rename."
3. [rename(file, line, col, "fetch_user")]
4. [diagnostics(project_path)]
5. "Renamed successfully. All 3 files updated, no type errors."
```

### Workflow: Add a Parameter

```
User: Add a 'timeout' parameter to fetch_data

Claude:
1. [function_signature(file, line, col)] → Get current params
2. "Current signature: fetch_data(url, headers)"
3. [change_signature(file, line, col, add_param={"name": "timeout", "default": "30"})]
4. "Added timeout parameter with default 30. Updated 8 call sites."
```

### Workflow: Move to Another Module

```
User: Move validate_email to utils.py

Claude:
1. [move(file, line, col, "utils.py", preview=True)] → Check impact
2. "This will update 4 files. Proceed?"
3. [move(file, line, col, "utils.py")]
4. [diagnostics(project_path)]
5. "Moved successfully. Imports updated in all affected files."
```

### Workflow: Understand Unfamiliar Code

```
User: Explain how UserService works

Claude:
1. [symbols("services/user.py")] → Get structure
2. [hover(file, 12, 7)] → Get UserService info
3. [definition(...)] → Find parent class
4. [references(...)] → See usage patterns
5. Synthesize explanation from gathered info
```

## Anti-Patterns

### DON'T: Manual Cross-File Edits

```
BAD:
1. Read file1.py
2. Edit: rename function
3. Read file2.py
4. Edit: update import
5. Read file3.py
6. Edit: update call
... (error-prone, may miss files)

GOOD:
1. [rename(file1.py, line, col, "new_name")]
... (all files updated atomically)
```

### DON'T: Read Files for Type Info

```
BAD:
1. Read entire models.py
2. Parse to understand User type

GOOD:
1. [hover(file, line, col)]
→ "User: class with fields id: int, name: str, email: str"
```

### DON'T: Skip Verification

```
BAD:
1. [rename(...)]
2. "Done!"

GOOD:
1. [rename(...)]
2. [diagnostics(...)]
3. "Renamed successfully, no type errors."
```

## Tips for Claude Code

1. **Parallel calls**: When exploring, call multiple `hover()` or `symbols()` in parallel
2. **Batch diagnostics**: Run `diagnostics()` once after all changes, not after each
3. **Use absolute paths**: MCP tools work best with absolute file paths
4. **Position precision**: Use `symbols()` to find exact line numbers if unsure
5. **Preview for safety**: Use `preview=True` on move/change_signature for unfamiliar code
