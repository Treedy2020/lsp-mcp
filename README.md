# PyLspMcp

MCP (Model Context Protocol) server that exposes [Pyright](https://github.com/microsoft/pyright) LSP features for Python code intelligence. Works with Claude Code, Codex, and other MCP-compatible AI tools.

## Implementations

This project provides multiple implementations:

- **[TypeScript](./ts/)** - Production-ready implementation
- **Python** - Coming soon

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

### TypeScript Version

```bash
# Run directly with npx
npx @treedy/pyright-mcp

# Or install globally
npm install -g @treedy/pyright-mcp
```

See [ts/README.md](./ts/README.md) for detailed documentation.

## Architecture

```
┌─────────────────┐     stdio      ┌─────────────────────┐     stdio      ┌──────────────────┐
│  Claude / AI    │ ◄────────────► │    pyright-mcp      │ ◄────────────► │ pyright-langserver│
│                 │      MCP       │                     │      LSP       │                  │
└─────────────────┘                └─────────────────────┘                └──────────────────┘
```

## License

MIT
