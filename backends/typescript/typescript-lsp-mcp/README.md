# TypeScript LSP MCP

MCP server providing TypeScript/JavaScript code intelligence using the official TypeScript Language Service.

## Features

- **hover** - Get type information and documentation at a position
- **definition** - Jump to symbol definition
- **references** - Find all references to a symbol
- **completions** - Get code completion suggestions
- **signature_help** - Get function signature information
- **symbols** - Extract symbols (classes, functions, methods, variables)
- **diagnostics** - Get type errors and warnings
- **rename** - Preview symbol renaming
- **search** - Search for patterns in files (ripgrep-style)
- **update_document** - Update file content for incremental analysis
- **status** - Check TypeScript environment status

## Installation

```bash
# Using npx
npx @treedy/typescript-lsp-mcp

# Or install globally
npm install -g @treedy/typescript-lsp-mcp
```

## MCP Configuration

Add to your `.mcp.json` or Claude Code settings:

```json
{
  "mcpServers": {
    "typescript-lsp": {
      "command": "npx",
      "args": ["@treedy/typescript-lsp-mcp"]
    }
  }
}
```

Or run directly with Bun:

```json
{
  "mcpServers": {
    "typescript-lsp": {
      "command": "bun",
      "args": ["run", "/path/to/typescript-lsp-mcp/dist/index.js"]
    }
  }
}
```

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run in development mode (with hot reload)
bun run dev

# Test with MCP Inspector
bun run inspector
```

## Architecture

Uses the official TypeScript Language Service API directly:

```
┌─────────────────┐     stdio      ┌─────────────────────┐
│  Claude / AI    │ ◄────────────► │  typescript-lsp-mcp │
│                 │      MCP       │                     │
└─────────────────┘                └─────────┬───────────┘
                                             │
                                             ▼
                                   ┌───────────────────┐
                                   │    TypeScript     │
                                   │  Language Service │
                                   └───────────────────┘
```

## License

MIT
