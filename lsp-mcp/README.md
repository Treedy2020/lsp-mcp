# @treedy/lsp-mcp

Unified MCP server aggregating multi-language LSP backends for code intelligence. One server provides Python and TypeScript code intelligence through namespaced tools.

## Features

- **Unified Entry Point**: Single MCP server for multiple languages
- **Namespaced Tools**: `python_hover`, `typescript_definition`, etc.
- **On-Demand Loading**: Backends are installed and started only when needed
- **Dynamic Tool Registration**: Backend tools are discovered automatically
- **Skill Prompts**: Best practices exposed as MCP prompts for agents
- **Graceful Degradation**: Clear error messages when backends unavailable

## Installation

```bash
npm install -g @treedy/lsp-mcp
```

Or use directly with npx:

```bash
npx @treedy/lsp-mcp
```

## Configuration

### Claude Code / AI Client

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "lsp-mcp": {
      "command": "npx",
      "args": ["@treedy/lsp-mcp@latest"]
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LSP_MCP_PYTHON_ENABLED` | `true` | Enable Python backend |
| `LSP_MCP_PYTHON_PROVIDER` | `python-lsp-mcp` | Python provider (`python-lsp-mcp` or `pyright-mcp`) |
| `LSP_MCP_TYPESCRIPT_ENABLED` | `true` | Enable TypeScript backend |
| `LSP_MCP_AUTO_UPDATE` | `true` | Automatically update backends to latest versions on startup |

### Auto-Update Behavior

When `LSP_MCP_AUTO_UPDATE=true` (default), backends are automatically updated on startup:

| Backend | Registry | Update Command |
|---------|----------|----------------|
| python-lsp-mcp (Rope) | PyPI | `uvx --upgrade python-lsp-mcp` |
| pyright-mcp | npm | `npx --yes @treedy/pyright-mcp@latest` |
| typescript-lsp-mcp | npm | `npx --yes @treedy/typescript-lsp-mcp@latest` |

This ensures backends are always up-to-date when the server starts. To disable auto-update and use cached versions, set `LSP_MCP_AUTO_UPDATE=false`.

## Available Tools

### Common Tools (both languages)

| Tool | Description |
|------|-------------|
| `{lang}_hover` | Get type information and documentation |
| `{lang}_definition` | Go to definition |
| `{lang}_references` | Find all references |
| `{lang}_completions` | Code completion suggestions |
| `{lang}_diagnostics` | Type errors and warnings |
| `{lang}_symbols` | Extract symbols from file |
| `{lang}_rename` | Rename symbol |
| `{lang}_search` | Regex pattern search |
| `{lang}_signature_help` | Function signature help |
| `{lang}_update_document` | Update file for incremental analysis |
| `{lang}_status` | Backend status |

Replace `{lang}` with `python` or `typescript`.

### Python-Only Tools

| Tool | Description |
|------|-------------|
| `python_move` | Move function/class to another module |
| `python_change_signature` | Modify function signature |
| `python_function_signature` | Get current function signature |
| `python_set_backend` | Switch between rope/pyright |
| `python_set_python_path` | Set Python interpreter |

### Meta Tools

| Tool | Description |
|------|-------------|
| `list_backends` | List available backends and their status |
| `start_backend` | Install and start a backend (downloads if needed) |
| `update_backend` | Update a backend to the latest version |
| `status` | Overall server and backend status with versions |
| `check_versions` | Detailed version info for server and all backends |
| `switch_python_backend` | Switch Python provider |

## Quick Start

1. **List available backends**:
   ```
   list_backends
   ```

2. **Start a backend** (this will download and install if needed):
   ```
   start_backend language=python
   start_backend language=typescript
   ```

3. **Use backend tools** (available after starting):
   ```
   python_hover file=/path/to/file.py line=10 column=5
   typescript_definition file=/path/to/file.ts line=15 column=10
   ```

4. **Update a backend** (when new version is available):
   ```
   update_backend language=python
   ```

## Available Prompts (Skills)

The server exposes skill documentation as MCP prompts that agents can request:

| Prompt | Description |
|--------|-------------|
| `code-navigation` | Navigate codebases using hover, definition, references |
| `refactoring` | Safe cross-file refactoring (rename, move, change_signature) |
| `code-analysis` | Code analysis techniques (symbols, diagnostics, search) |
| `lsp-rules` | Best practices for using LSP tools effectively |
| `lsp-quick-start` | Quick reference guide for essential workflows |

### Key Workflows from Prompts

**1. Search → LSP Tools**
```
search("ClassName") → get positions
hover(file, line, column) → get type info
definition(...) → jump to definition
references(...) → find usages
```

**2. Learn API Before Using**
```
hover(file, line, column) → get documentation
signature_help(...) → get parameter details
→ Then write correct code
```

**3. Always Verify with Diagnostics**
```
Edit code
diagnostics(path) → check for errors
Fix issues
Repeat until clean
```

## Usage Examples

### Python Hover

```json
{
  "name": "python_hover",
  "arguments": {
    "file": "/path/to/file.py",
    "line": 10,
    "column": 5
  }
}
```

### TypeScript Definition

```json
{
  "name": "typescript_definition",
  "arguments": {
    "file": "/path/to/file.ts",
    "line": 15,
    "column": 10
  }
}
```

### Auto Language Detection

If you don't use namespaced tools, the language is inferred from the file extension:

```json
{
  "name": "hover",
  "arguments": {
    "file": "/path/to/file.py"
  }
}
```

This will automatically route to the Python backend.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Claude Code / AI Client                     │
└─────────────────────────────────────────────────────────────────┘
                              │ MCP (stdio)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        @treedy/lsp-mcp                        │
│                      (Unified MCP Server)                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Tool Router                              │ │
│  │  - Parse tool name (python_hover → {lang, tool})           │ │
│  │  - Infer language from file extension                      │ │
│  │  - Route to appropriate backend                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  Backend Manager                            │ │
│  │  - Lazy load backend processes                             │ │
│  │  - Health check and auto-restart                           │ │
│  │  - Graceful shutdown                                        │ │
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

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run in development mode
bun run dev

# Run tests
bun run test

# Test with MCP Inspector
bun run inspector
```

### Local Development Mode

For testing with local backend packages (not published to npm/PyPI):

```bash
# Set environment variable for local mode
export LSP_MCP_LOCAL=1

# Or set the project root explicitly
export LSP_MCP_ROOT=/path/to/PyLspMcp

# Then run the server
bun dist/index.js
```

In local mode, backends are started from:
- Python (pyright-mcp): `{root}/backends/python/pyright-mcp/dist/index.js`
- Python (python-lsp-mcp): `{root}/backends/python/python-lsp-mcp` via `uv run`
- TypeScript: `{root}/backends/typescript/typescript-lsp-mcp/dist/index.js`

## Dependencies

The unified server requires the backend packages to be available:

- **Python**: `python-lsp-mcp` (via uvx) or `@treedy/pyright-mcp` (via npx)
- **TypeScript**: `@treedy/typescript-lsp-mcp` (via npx)

These are installed automatically when the respective backends are first used.

## License

MIT
