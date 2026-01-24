# PyLspMcp

MCP (Model Context Protocol) servers for Python code intelligence. Designed for **LLM agents** like Claude Code, Codex, and other AI coding assistants.

## Why MCP for Code Intelligence?

LLM agents need to understand code structure to help effectively. These MCP servers provide:

- **Cross-file references** - Find all usages of a symbol across your codebase
- **Definition jumping** - Navigate to where functions/classes are defined
- **Type information** - Get accurate type hints and documentation
- **Symbol extraction** - Understand code structure at a glance

Unlike IDE plugins where millisecond latency matters, MCP servers optimize for **correctness over speed**. A response under 1 second is perfectly fine - what matters is giving the LLM accurate information to prevent hallucinations.

## Implementations

| Implementation | Language | Backend | Best For |
|----------------|----------|---------|----------|
| **[pyright-mcp](./ts/)** | TypeScript | Pyright LSP | Type-heavy projects, diagnostics |
| **[python-lsp-mcp](./python/)** | Python | Rope + Pyright | Quick setup, refactoring |

See [docs/FEATURES.md](./docs/FEATURES.md) for detailed feature comparison.

## Features

- **hover** - Get type information and documentation at a position
- **definition** - Jump to symbol definition
- **references** - Find all references to a symbol
- **completions** - Get code completion suggestions
- **diagnostics** - Get type errors and warnings
- **signature_help** - Get function signature information
- **rename** - Preview symbol renaming
- **search** - Search for patterns in files (ripgrep-style)
- **status** - Check Python/Pyright environment status
- **symbols** - Extract symbols (classes, functions, methods, variables)
- **update_document** - Update file content for incremental analysis

## Quick Start

### TypeScript Version (pyright-mcp)

```bash
# Run directly with npx
npx @treedy/pyright-mcp

# Or install globally
npm install -g @treedy/pyright-mcp
```

See [ts/README.md](./ts/README.md) for detailed documentation.

### Python Version (python-lsp-mcp)

```bash
cd python

# Install with uv
uv sync

# Run the server
uv run python-lsp-mcp
```

See [python/README.md](./python/README.md) for detailed documentation.

## MCP Configuration

Add to your `.mcp.json` or Claude Code settings:

### Using pyright-mcp (TypeScript)

```json
{
  "mcpServers": {
    "pyright-mcp": {
      "command": "npx",
      "args": ["@treedy/pyright-mcp@latest"]
    }
  }
}
```

### Using python-lsp-mcp (Python)

python-lsp-mcp supports two backends:
- **rope** (default) - Fast, low latency, good for quick operations
- **pyright** - Accurate type inference, better cross-file analysis

#### Default (Rope backend - faster)

```json
{
  "mcpServers": {
    "python-lsp-mcp": {
      "command": "uvx",
      "args": ["python-lsp-mcp@latest"]
    }
  }
}
```

#### With Pyright backend (more accurate)

```json
{
  "mcpServers": {
    "python-lsp-mcp": {
      "command": "uvx",
      "args": ["python-lsp-mcp@latest"],
      "env": {
        "PYTHON_LSP_MCP_BACKEND": "pyright"
      }
    }
  }
}
```

#### Hybrid (Pyright for hover/definition, Rope for others)

```json
{
  "mcpServers": {
    "python-lsp-mcp": {
      "command": "uvx",
      "args": ["python-lsp-mcp@latest"],
      "env": {
        "PYTHON_LSP_MCP_HOVER_BACKEND": "pyright",
        "PYTHON_LSP_MCP_DEFINITION_BACKEND": "pyright"
      }
    }
  }
}
```

> **Tip**: You can also switch backends at runtime using the `set_backend` tool.

### Using Both Implementations

```json
{
  "mcpServers": {
    "pyright-mcp": {
      "command": "npx",
      "args": ["@treedy/pyright-mcp@latest"]
    },
    "python-lsp-mcp": {
      "command": "uvx",
      "args": ["python-lsp-mcp@latest"]
    }
  }
}
```

## Agent Skills & Rules

The [skills/](./skills/) folder contains guidance for AI agents to use this MCP effectively:

| Document | Description |
|----------|-------------|
| [code-navigation.md](./skills/code-navigation.md) | Navigate code with hover, definition, references |
| [refactoring.md](./skills/refactoring.md) | Safe cross-file refactoring (rename, move, change_signature) |
| [code-analysis.md](./skills/code-analysis.md) | Analyze code structure and find errors |
| [rules.md](./skills/rules.md) | Best practices and anti-patterns |
| [claude-code.md](./skills/claude-code.md) | Claude Code specific integration |

### Key Rules for LLMs

1. **Use LSP before reading files** - `hover()` is faster than reading entire files
2. **Use refactoring tools for cross-file changes** - `rename()` beats manual search-replace
3. **Verify after refactoring** - Always run `diagnostics()` to catch errors
4. **Preview large changes** - Use `preview=True` before applying

## Architecture

### pyright-mcp (TypeScript)

```
┌─────────────────┐     stdio      ┌─────────────────────┐     stdio      ┌──────────────────┐
│  Claude / AI    │ ◄────────────► │    pyright-mcp      │ ◄────────────► │ pyright-langserver│
│                 │      MCP       │                     │      LSP       │                  │
└─────────────────┘                └─────────────────────┘                └──────────────────┘
```

### python-lsp-mcp (Python)

```
┌─────────────────┐     stdio      ┌─────────────────────┐
│  Claude / AI    │ ◄────────────► │      python-lsp-mcp       │
│                 │      MCP       │                     │
└─────────────────┘                └─────────┬───────────┘
                                             │
                           ┌─────────────────┼─────────────────┐
                           ▼                 ▼                 ▼
                    ┌───────────┐     ┌───────────┐     ┌───────────┐
                    │   Rope    │     │  Pyright  │     │ Pyright   │
                    │  Library  │     │   CLI     │     │   LSP     │
                    └───────────┘     └───────────┘     └───────────┘
```

## License

MIT
