# Python LSP MCP Server

Python MCP server providing code analysis features using [Rope](https://github.com/python-rope/rope) and [Pyright](https://github.com/microsoft/pyright).

## Features

| Tool | Description | Backend |
|------|-------------|---------|
| `hover` | Get documentation at position | Rope/Pyright |
| `definition` | Go to symbol definition | Rope/Pyright |
| `references` | Find all references | Rope/Pyright |
| `completions` | Code completion suggestions | Rope/Pyright |
| `symbols` | Extract document symbols | Rope/Pyright |
| `rename` | Rename refactoring | Rope |
| `diagnostics` | Type checking errors | Pyright |
| `signature_help` | Function signatures | Pyright |
| `update_document` | Incremental document updates | Pyright |
| `search` | Regex search in files | ripgrep |
| `set_backend` | Switch backend at runtime | - |
| `status` | Server status info | - |

## Installation

### From PyPI (Recommended)

```bash
# Using uvx (no install needed)
uvx python-lsp-mcp@latest

# Using pipx
pipx install python-lsp-mcp

# Using pip
pip install python-lsp-mcp
```

### From Source

```bash
cd python
uv sync
uv run python-lsp-mcp
```

## Usage

### Run the server

```bash
# With uvx (recommended)
uvx python-lsp-mcp@latest

# With pip install
python-lsp-mcp

# From source
uv run python-lsp-mcp
```

### Configure in Claude Code

Add to your `.mcp.json` or MCP settings:

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

Or if installed from source:

```json
{
  "mcpServers": {
    "python-lsp-mcp": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/PyLspMcp/python", "python-lsp-mcp"]
    }
  }
}
```

### MCP Inspector

```bash
uvx mcp dev python-lsp-mcp
```

## Configuration

### Backend Selection

The server supports two backends for shared tools (hover, definition, references, completions, symbols):

| Backend | Strengths | Use Case |
|---------|-----------|----------|
| **rope** (default) | Fast, low latency, good refactoring | Quick operations, CI/CD |
| **pyright** | Accurate types, cross-file analysis | Type-heavy projects |

### Runtime Switching

Use the `set_backend` tool to switch backends at runtime:

```python
# Switch all shared tools to pyright
set_backend(backend="pyright")

# Switch only hover to rope
set_backend(backend="rope", tool="hover")

# Check current configuration
status()
```

### Environment Variables

Configure backends at startup via environment variables (supports both prefixes):

| Variable | Description | Default |
|----------|-------------|---------|
| `PYTHON_LSP_MCP_BACKEND` | Default backend (`rope` or `pyright`) | `rope` |
| `PYTHON_LSP_MCP_HOVER_BACKEND` | Backend for hover | inherited |
| `PYTHON_LSP_MCP_DEFINITION_BACKEND` | Backend for definition | inherited |
| `PYTHON_LSP_MCP_REFERENCES_BACKEND` | Backend for references | inherited |
| `PYTHON_LSP_MCP_COMPLETIONS_BACKEND` | Backend for completions | inherited |
| `PYTHON_LSP_MCP_SYMBOLS_BACKEND` | Backend for symbols | inherited |

> Note: `ROPE_MCP_*` prefix is also supported for backward compatibility.

Example:
```bash
# Use pyright for all shared tools
PYTHON_LSP_MCP_BACKEND=pyright uvx python-lsp-mcp@latest

# Use pyright for hover only
PYTHON_LSP_MCP_HOVER_BACKEND=pyright uvx python-lsp-mcp@latest
```

## Development

### Run tests

```bash
uv run pytest tests/ -v
```

### Run benchmarks

```bash
uv run pytest tests/test_benchmark.py -v -s
```

## Architecture

```
┌─────────────────┐     stdio      ┌─────────────────────┐
│  Claude / AI    │ ◄────────────► │     python-lsp-mcp        │
│                 │      MCP       │                     │
└─────────────────┘                └─────────┬───────────┘
                                             │
                           ┌─────────────────┼─────────────────┐
                           │                 │                 │
                           ▼                 ▼                 ▼
                    ┌───────────┐     ┌───────────┐     ┌───────────┐
                    │   Rope    │     │  Pyright  │     │ Pyright   │
                    │  Library  │     │   CLI     │     │   LSP     │
                    └───────────┘     └───────────┘     └───────────┘
```

## Project Structure

```
python/
├── pyproject.toml
├── src/rope_mcp/
│   ├── server.py           # MCP server entry point
│   ├── rope_client.py      # Rope library wrapper
│   ├── pyright_client.py   # Pyright CLI wrapper
│   ├── config.py           # Backend configuration
│   ├── lsp/                # LSP client for Pyright
│   │   ├── client.py
│   │   └── types.py
│   └── tools/              # Tool implementations
│       ├── hover.py
│       ├── definition.py
│       ├── references.py
│       ├── completions.py
│       ├── symbols.py
│       ├── rename.py
│       └── diagnostics.py
└── tests/
    ├── test_tools.py
    └── test_benchmark.py
```

## Performance

Rope is significantly faster than Pyright LSP for basic operations:

| Tool | Rope (ms) | Pyright (ms) | Speedup |
|------|-----------|--------------|---------|
| hover | 0.16 | 0.79 | 4.9x |
| definition | 0.12 | 0.40 | 3.3x |
| completions | 0.36 | 1.52 | 4.2x |
| symbols | 0.24 | 0.44 | 1.8x |

See [docs/BENCHMARKS.md](../docs/BENCHMARKS.md) for detailed benchmarks.

## License

MIT
