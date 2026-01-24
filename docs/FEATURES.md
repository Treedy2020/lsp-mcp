# PyLspMcp Features Roadmap

This document tracks the features implemented and planned for the PyLspMcp project.

## Feature Status

### Core Features

| Feature | TypeScript | Python (Rope) | Python (Pyright) | Priority |
|---------|------------|---------------|------------------|----------|
| hover | ✅ | ✅ | ✅ | P0 |
| definition | ✅ | ✅ | ✅ | P0 |
| references | ✅ | ✅ | ✅ | P0 |
| completions | ✅ | ✅ | ✅ | P0 |
| symbols | ✅ | ✅ | ✅ | P0 |
| rename | ✅ | ✅ | - | P0 |
| diagnostics | ✅ | - | ✅ | P0 |
| signature_help | ✅ | - | ✅ | P1 |
| update_document | ✅ | - | ✅ | P1 |
| status | ✅ | ✅ | - | P2 |
| search | ✅ | ✅ | - | P2 |

### Planned Features

| Feature | Description | Target | Status |
|---------|-------------|--------|--------|
| workspace_symbols | Search symbols across workspace | v0.3.0 | Planned |
| code_actions | Quick fixes and refactorings | v0.3.0 | Planned |
| type_hierarchy | Show type inheritance | v0.4.0 | Planned |
| call_hierarchy | Show call relationships | v0.4.0 | Planned |
| inlay_hints | Inline type hints | v0.4.0 | Planned |
| semantic_tokens | Token classification | v0.5.0 | Research |

## Backend Comparison

### Rope (Python)

**Strengths:**
- Fast for basic operations (4-5x faster than Pyright LSP)
- Excellent refactoring support (rename, extract, inline)
- Pure Python, no external dependencies
- Low memory footprint
- Consistent, low-variance performance

**Limitations:**
- No type checking / diagnostics
- Limited signature help
- Cross-file analysis less accurate
- No incremental parsing

**Best for:**
- Quick refactoring tasks
- Low-latency requirements
- Minimal dependency environments
- CI/CD pipelines

### Pyright (TypeScript LSP)

**Strengths:**
- Full type checking with diagnostics
- Accurate type inference
- Excellent cross-file analysis
- Incremental updates
- Rich signature help

**Limitations:**
- Slower cold start (~1-2s)
- Higher memory usage
- Requires Node.js runtime
- More complex setup

**Best for:**
- Type-heavy projects
- Large codebases
- Projects requiring diagnostics
- Full IDE-like experience

### Hybrid Approach (python-lsp-mcp)

The python-lsp-mcp server supports both backends, allowing you to:
- Use Rope for fast operations (hover, definition, completions)
- Use Pyright for diagnostics and signature help
- Switch backends per-tool via configuration

## Implementation Details

### Rope APIs Used

| Feature | Rope API |
|---------|----------|
| hover | `codeassist.get_doc()` |
| definition | `codeassist.get_definition_location()` |
| references | `findit.find_occurrences()` |
| completions | `codeassist.code_assist()` |
| symbols | Python `ast` module |
| rename | `rope.refactor.rename.Rename` |

### Pyright Integration

| Mode | Description |
|------|-------------|
| CLI | `pyright --outputjson` for diagnostics |
| LSP | `pyright-langserver --stdio` for full features |

## Quality Metrics

### Test Coverage Goals

| Area | Current | Target |
|------|---------|--------|
| Tools | 90% | 95% |
| Client | 80% | 90% |
| Integration | 70% | 85% |

### Performance Targets

| Operation | Target (ms) | Achieved |
|-----------|-------------|----------|
| hover | < 1.0 | ✅ 0.16 |
| definition | < 1.0 | ✅ 0.12 |
| references | < 20.0 | ✅ 14.2 |
| completions | < 2.0 | ✅ 0.36 |
| symbols | < 1.0 | ✅ 0.24 |

## Version History

### v0.2.0 (Current)
- Dual backend support (Rope + Pyright)
- LSP client for Pyright language server
- Configurable backend per-tool
- Benchmark test suite

### v0.1.0
- Initial Rope-based implementation
- Basic MCP tools (hover, definition, references, completions, symbols, rename)
- pytest test suite

## Contributing

See the main [README.md](../README.md) for contribution guidelines.

## References

- [Rope Documentation](https://rope.readthedocs.io/)
- [Pyright Documentation](https://microsoft.github.io/pyright/)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [LSP Specification](https://microsoft.github.io/language-server-protocol/)
