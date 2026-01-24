# PyLspMcp

MCP (Model Context Protocol) servers for Python code intelligence. Works with Claude Code, Codex, and other MCP-compatible AI tools.

## Implementations

This project provides multiple implementations:

| Implementation | Language | Backend | Description |
|----------------|----------|---------|-------------|
| **[pyright-mcp](./ts/)** | TypeScript | Pyright LSP | Full-featured with type checking |
| **[python-lsp-mcp](./python/)** | Python | Rope + Pyright | Fast, Python-native |

See [docs/FEATURES.md](./docs/FEATURES.md) for detailed feature comparison and [docs/BENCHMARKS.md](./docs/BENCHMARKS.md) for performance data.

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
