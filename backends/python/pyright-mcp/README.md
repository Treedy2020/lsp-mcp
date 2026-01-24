# @treedy/pyright-mcp (TypeScript)

MCP (Model Context Protocol) server that exposes [Pyright](https://github.com/microsoft/pyright) LSP features for Python code intelligence. Works with Claude Code, Codex, and other MCP-compatible AI tools.

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

## Prerequisites

Install Pyright globally:

```bash
npm install -g pyright
```

## Quick Start with npx

You can run directly without installation:

```bash
npx @treedy/pyright-mcp
```

## Installation

```bash
npm install -g @treedy/pyright-mcp
```

## Usage

### With Claude Code

Add to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pyright": {
      "command": "npx",
      "args": ["@treedy/pyright-mcp"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "pyright": {
      "command": "pyright-mcp"
    }
  }
}
```

### With Other MCP Clients

Run the server via stdio:

```bash
npx @treedy/pyright-mcp
```

## Project Configuration

pyright-mcp automatically detects your project root by looking for:
- `pyrightconfig.json`
- `pyproject.toml`
- `.git` directory

### Basic pyrightconfig.json

Create a `pyrightconfig.json` in your project root:

```json
{
  "include": ["src"],
  "pythonVersion": "3.11",
  "typeCheckingMode": "basic"
}
```

### With Virtual Environment

```json
{
  "include": ["src"],
  "pythonVersion": "3.11",
  "venvPath": ".",
  "venv": ".venv",
  "typeCheckingMode": "strict"
}
```

### Using pyproject.toml

Add a `[tool.pyright]` section to your `pyproject.toml`:

```toml
[tool.pyright]
include = ["src"]
pythonVersion = "3.11"
typeCheckingMode = "basic"
```

## Tool Examples

### Check Environment Status

```
Tool: status
Arguments: { "file": "/path/to/your/project/main.py" }
```

Returns project root, Pyright version, config details, and Python environment info.

### Get Hover Information

```
Tool: hover
Arguments: { "file": "/path/to/file.py", "line": 10, "column": 5 }
```

### Go to Definition

```
Tool: definition
Arguments: { "file": "/path/to/file.py", "line": 10, "column": 5 }
```

### Find References

```
Tool: references
Arguments: { "file": "/path/to/file.py", "line": 10, "column": 5 }
```

### Get Completions

```
Tool: completions
Arguments: { "file": "/path/to/file.py", "line": 10, "column": 5 }
```

### Get Diagnostics

```
Tool: diagnostics
Arguments: { "file": "/path/to/file.py" }
```

### Get Symbols

```
Tool: symbols
Arguments: { "file": "/path/to/file.py", "filter": "classes" }
```

Filter options: `all`, `classes`, `functions`, `methods`, `variables`

### Search in Files

```
Tool: search
Arguments: { "pattern": "def main", "path": "/path/to/project", "glob": "*.py" }
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test with MCP Inspector
npm run inspector

# Run tests
npm run test:mcp
```

## Publishing to npm

```bash
# Login to npm
npm login

# Publish (scoped packages need --access public for first publish)
npm publish --access public
```

After publishing, users can run directly with:

```bash
npx @treedy/pyright-mcp
```

## Architecture

```
┌─────────────────┐     stdio      ┌─────────────────────┐     stdio      ┌──────────────────┐
│  Claude / AI    │ ◄────────────► │    pyright-mcp      │ ◄────────────► │ pyright-langserver│
│                 │      MCP       │                     │      LSP       │                  │
└─────────────────┘                └─────────────────────┘                └──────────────────┘
```

1. AI client sends MCP tool calls (e.g., hover, definition)
2. pyright-mcp converts to LSP requests
3. pyright-langserver analyzes Python code
4. Results are formatted and returned to the AI

## License

MIT
