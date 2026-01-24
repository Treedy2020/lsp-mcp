# LSP MCP Skills

Agent skills and rules for effectively using the `lsp-mcp` server (Python + TypeScript).

## Skills

| Skill | Description | When to Use |
|-------|-------------|-------------|
| [code-navigation](./code-navigation.md) | Navigate codebases efficiently | Finding definitions, understanding code structure |
| [refactoring](./refactoring.md) | Safe cross-file refactoring | Renaming, moving code, changing signatures |
| [code-analysis](./code-analysis.md) | Analyze and understand code | Type checking, finding symbols, diagnostics |

## Rules

See [rules.md](./rules.md) for best practices when using these tools.

## Key Workflows

### 1. Search → LSP Tools

`search()` returns positions (file, line, column) that work directly with other LSP tools:

```
search("ClassName") → get positions
hover(file, line, column) → get type info
definition(...) → jump to definition
references(...) → find usages
```

### 2. Learn API Before Using

Before using unfamiliar methods/classes:

```
hover(file, line, column) → get documentation
signature_help(...) → get parameter details
→ Then write correct code
```

### 3. Always Verify with Diagnostics

After any code changes:

```
Edit code
diagnostics(path) → check for errors
Fix issues
Repeat until clean
```

## Quick Reference

```
# Navigation (use python/ or typescript/ prefix)
hover(file, line, column)           → Get type info and docs
definition(file, line, column)      → Jump to definition
references(file, line, column)      → Find all usages

# Analysis
symbols(file)                       → List all symbols in file
diagnostics(path)                   → Type errors and warnings
search(pattern, path)               → Search code, returns LSP positions

# Refactoring (Python only, modifies files)
rename(file, line, column, new_name)              → Rename symbol
move(file, line, column, destination)             → Move to another module
change_signature(file, line, column, ...)         → Modify function params
```

## Tool Namespacing

Tools are namespaced by language:
- `python/hover`, `python/definition`, etc.
- `typescript/hover`, `typescript/definition`, etc.

Or use file extension auto-detection by providing a file path.
