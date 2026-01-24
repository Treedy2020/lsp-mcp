# LSP MCP

MCP (Model Context Protocol) servers for **Python and TypeScript** code intelligence. Designed for **LLM agents** like Claude Code, Codex, and other AI coding assistants.

## Why MCP for Code Intelligence?

LLM agents need to understand code structure to help effectively. These MCP servers provide:

- **Cross-file references** - Find all usages of a symbol across your codebase
- **Definition jumping** - Navigate to where functions/classes are defined
- **Type information** - Get accurate type hints and documentation
- **Symbol extraction** - Understand code structure at a glance
- **Safe refactoring** - Rename, move, change signatures across files

Unlike IDE plugins where millisecond latency matters, MCP servers optimize for **correctness over speed**. A response under 1 second is perfectly fine - what matters is giving the LLM accurate information to prevent hallucinations.

## Quick Start (Recommended)

Use the **unified lsp-mcp server** that provides both Python and TypeScript support:

```json
{
  "mcpServers": {
    "lsp-mcp": {
      "command": "npx",
      "args": ["@anthropic/lsp-mcp@latest"]
    }
  }
}
```

This single server provides:
- **Namespaced tools**: `python/hover`, `typescript/definition`, etc.
- **Auto language detection**: Infers language from file extensions
- **Auto-update**: Backends updated to latest versions on startup
- **Lazy loading**: Backends start only when first used

## Features

| Feature | Python | TypeScript | Description |
|---------|--------|------------|-------------|
| hover | ✓ | ✓ | Get type information and documentation |
| definition | ✓ | ✓ | Jump to symbol definition |
| references | ✓ | ✓ | Find all references to a symbol |
| completions | ✓ | ✓ | Get code completion suggestions |
| diagnostics | ✓ | ✓ | Get type errors and warnings |
| symbols | ✓ | ✓ | Extract symbols from a file |
| rename | ✓ | ✓ | Rename symbol across files |
| search | ✓ | ✓ | Regex search in codebase |
| signature_help | ✓ | ✓ | Get function signature info |
| move | ✓ | - | Move function/class to another module |
| change_signature | ✓ | - | Modify function parameters |

## Project Structure

```
lsp-mcp/                    # Unified MCP server (recommended)
backends/
  python/
    python-lsp-mcp/         # Python backend (Rope + Pyright)
    pyright-mcp/            # Python backend (Pyright only)
    fixtures/               # Test fixtures
  typescript/
    typescript-lsp-mcp/     # TypeScript backend
    fixtures/               # Test fixtures
skills/                     # Agent skills and rules
```

## Individual Backends

If you prefer to use backends separately:

### Python (python-lsp-mcp)

```json
{
  "mcpServers": {
    "python-lsp-mcp": {
      "command": "uvx",
      "args": ["python-lsp-mcp"]
    }
  }
}
```

Supports two analysis backends:
- **rope** (default) - Fast, Python-native, supports refactoring
- **pyright** - Full type checking, better cross-file analysis

### Python (pyright-mcp)

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

TypeScript implementation using Pyright LSP directly.

### TypeScript (typescript-lsp-mcp)

```json
{
  "mcpServers": {
    "typescript-lsp-mcp": {
      "command": "npx",
      "args": ["@treedy/typescript-lsp-mcp@latest"]
    }
  }
}
```

## Agent Skills & Rules

The [skills/](./skills/) folder contains guidance for AI agents:

| Document | Description |
|----------|-------------|
| [code-navigation.md](./skills/code-navigation.md) | Navigate code with hover, definition, references |
| [refactoring.md](./skills/refactoring.md) | Safe cross-file refactoring |
| [code-analysis.md](./skills/code-analysis.md) | Analyze code structure and find errors |
| [rules.md](./skills/rules.md) | Best practices for using LSP tools |

### Key Rules for LLMs

1. **Use LSP before reading files** - `hover()` is faster than reading entire files
2. **Use search() to get LSP positions** - Results can be used directly with other tools
3. **Learn APIs before coding** - Use `hover()` and `signature_help()` before using unfamiliar methods
4. **Always verify with diagnostics** - Run `diagnostics()` after any code changes
5. **Use refactoring tools for cross-file changes** - `rename()` beats manual search-replace

## Configuration

### Environment Variables (lsp-mcp)

| Variable | Default | Description |
|----------|---------|-------------|
| `LSP_MCP_PYTHON_ENABLED` | `true` | Enable Python backend |
| `LSP_MCP_PYTHON_PROVIDER` | `python-lsp-mcp` | Python provider (`python-lsp-mcp` or `pyright-mcp`) |
| `LSP_MCP_TYPESCRIPT_ENABLED` | `true` | Enable TypeScript backend |
| `LSP_MCP_AUTO_UPDATE` | `true` | Auto-update backends on startup |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Claude Code / AI Client                     │
└─────────────────────────────────────────────────────────────────┘
                              │ MCP (stdio)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          lsp-mcp                                 │
│                    (Unified MCP Server)                          │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Tool Router                              │ │
│  │  python/hover → Python backend                             │ │
│  │  typescript/definition → TypeScript backend                │ │
│  └────────────────────────────────────────────────────────────┘ │
│         │                                      │                 │
│         ▼                                      ▼                 │
│  ┌────────────┐                        ┌────────────┐           │
│  │  Python    │                        │ TypeScript │           │
│  │  Backend   │                        │  Backend   │           │
│  └────────────┘                        └────────────┘           │
└─────────────────────────────────────────────────────────────────┘
        │ MCP (stdio)                          │ MCP (stdio)
        ▼                                      ▼
┌──────────────┐                        ┌──────────────┐
│python-lsp-mcp│                        │typescript-   │
│ (subprocess) │                        │ lsp-mcp      │
└──────────────┘                        └──────────────┘
```

## License

MIT
