# Python LSP MCP Skills

Agent skills and rules for effectively using the `python-lsp-mcp` server.

## Skills

| Skill | Description | When to Use |
|-------|-------------|-------------|
| [code-navigation](./code-navigation.md) | Navigate codebases efficiently | Finding definitions, understanding code structure |
| [refactoring](./refactoring.md) | Safe cross-file refactoring | Renaming, moving code, changing signatures |
| [code-analysis](./code-analysis.md) | Analyze and understand code | Type checking, finding symbols, diagnostics |

## Rules

See [rules.md](./rules.md) for best practices when using these tools.

## Quick Reference

```
# Navigation
hover(file, line, column)           → Get type info and docs
definition(file, line, column)      → Jump to definition
references(file, line, column)      → Find all usages

# Refactoring (modifies files)
rename(file, line, column, new_name)              → Rename symbol
move(file, line, column, destination)             → Move to another module
change_signature(file, line, column, ...)         → Modify function params

# Analysis
symbols(file)                       → List all symbols in file
diagnostics(path)                   → Type errors and warnings
search(pattern, path)               → Search code with regex
```
