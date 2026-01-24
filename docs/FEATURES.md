# PyLspMcp Features

## Design Philosophy

This MCP server is designed for **LLM agents**, not human IDE users. This means:

- **Correctness over speed** - Accurate information prevents LLM hallucinations
- **Cross-file operations** - LLMs need to understand code relationships across files
- **Sub-second is fine** - Unlike IDEs, LLMs don't need millisecond latency

## Feature Status

### Core Features

| Feature | TypeScript | Python (Rope) | Python (Pyright) |
|---------|------------|---------------|------------------|
| hover | ✅ | ✅ | ✅ |
| definition | ✅ | ✅ | ✅ |
| references | ✅ | ✅ | ✅ |
| completions | ✅ | ✅ | ✅ |
| symbols | ✅ | ✅ | ✅ |
| rename | ✅ | ✅ | - |
| diagnostics | ✅ | - | ✅ |
| signature_help | ✅ | - | ✅ |
| search | ✅ | ✅ | - |
| set_backend | - | ✅ | - |
| set_python_path | - | ✅ | - |
| status | ✅ | ✅ | - |

## What Matters Most for LLMs

### Critical

| Feature | Why |
|---------|-----|
| **Cross-file references** | LLMs need to trace code flow across modules |
| **Accurate definitions** | Wrong locations cause cascading errors |
| **Correct type info** | Prevents type-related hallucinations |

### Important

| Feature | Why |
|---------|-----|
| **Symbol extraction** | Helps LLMs understand code structure |
| **Completions** | Provides accurate API suggestions |
| **Diagnostics** | Catches errors before execution |

### Nice to Have

| Feature | Why |
|---------|-----|
| Low latency | LLMs process results, not real-time typing |
| Incremental updates | Each request is typically independent |

## Backend Comparison

### Rope (Python)

**Strengths:**
- Pure Python, no external dependencies
- Excellent refactoring (rename, extract, inline)
- Low memory footprint
- Fast startup

**Limitations:**
- No type checking / diagnostics
- Basic type inference
- Cross-file analysis less comprehensive

**Best for:**
- Quick refactoring tasks
- Minimal dependency environments
- Projects without complex type annotations

### Pyright

**Strengths:**
- Full type checking with diagnostics
- Accurate type inference for generics
- Excellent cross-file analysis
- Rich hover information

**Limitations:**
- Requires pyright-langserver (via npm)
- Higher memory usage

**Best for:**
- Type-heavy projects
- Large codebases with complex types
- Projects requiring diagnostics

### Hybrid Approach

python-lsp-mcp supports runtime backend switching:

```bash
# Set default backend via environment
PYTHON_LSP_MCP_BACKEND=pyright

# Or per-tool
PYTHON_LSP_MCP_HOVER_BACKEND=pyright
PYTHON_LSP_MCP_DEFINITION_BACKEND=pyright
```

You can also switch at runtime using the `set_backend` tool.

## Python Interpreter Detection

python-lsp-mcp automatically detects the Python interpreter:

1. **Manual override** via `set_python_path` tool
2. **Pyright config** from `pyrightconfig.json` or `pyproject.toml`
3. **Virtual environment** (`.venv`, `venv`, `env`)
4. **System Python** (fallback)

## Version History

### v0.2.0 (Current)
- Dual backend support (Rope + Pyright)
- Runtime backend switching
- Python interpreter auto-detection
- Cross-file reference support

### v0.1.0
- Initial implementation
- Basic MCP tools

## References

- [Rope Documentation](https://rope.readthedocs.io/)
- [Pyright Documentation](https://microsoft.github.io/pyright/)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
