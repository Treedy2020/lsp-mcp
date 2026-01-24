# Performance Notes

## Context: MCP for LLMs

Unlike traditional IDE integrations where millisecond-level latency is critical for a smooth typing experience, MCP servers are designed for **LLM agents** (like Claude Code, Codex, etc.).

For LLMs:
- **Response times under 1 second are perfectly acceptable** - the LLM is processing context, not waiting for real-time feedback
- **Correctness is far more important than speed** - a correct answer in 500ms beats an incorrect one in 10ms
- **Cross-file operations matter most** - LLMs benefit greatly from accurate multi-file reference tracking, definition jumping, and symbol analysis

## What Matters

### High Priority

| Capability | Why It Matters |
|------------|----------------|
| **Cross-file references** | LLMs need to understand how code connects across files |
| **Accurate type info** | Correct type information prevents hallucinations |
| **Symbol resolution** | Finding definitions helps LLMs understand code structure |
| **Reliable completions** | Accurate suggestions reduce coding errors |

### Lower Priority

| Capability | Why It's Less Critical |
|------------|----------------------|
| Sub-100ms latency | LLMs don't need real-time feedback |
| Incremental updates | Each request is typically independent |
| Memory optimization | Server runs separately, not in-editor |

## Backend Comparison

Both backends provide correct results for typical operations. Choose based on your needs:

| Aspect | Rope | Pyright |
|--------|------|---------|
| **Cross-file references** | Good | Excellent |
| **Type inference** | Basic | Full |
| **Rename refactoring** | Excellent (cross-file) | Good |
| **Move refactoring** | ✅ Cross-file | N/A |
| **Change signature** | ✅ Updates call sites | N/A |
| **Diagnostics** | N/A | Full |
| **Setup** | Zero config | Zero config |

### Why Refactoring Tools Matter for LLMs

LLMs struggle with:
- **Updating imports across files** when moving code
- **Updating all call sites** when changing function signatures
- **Consistent renames** across a large codebase

The Rope-only tools (move, change_signature, rename) handle these correctly and atomically, making them invaluable for AI-assisted refactoring.

## Recommendation

For most use cases, **either backend works well**. The differences are:

- Use **Pyright backend** if you need:
  - Precise type information for type-heavy codebases
  - Diagnostics and type error checking
  - Better inference for complex generic types

- Use **Rope backend** if you need:
  - Faster startup time
  - Better rename refactoring
  - Lower memory usage

You can also use both: configure Pyright for hover/definition (where type accuracy matters) and Rope for references/completions (where speed helps).

## Raw Benchmark Data

For reference, here are the raw performance numbers. Remember: these millisecond differences don't matter much for LLM usage.

### Test Environment

| Property | Value |
|----------|-------|
| Machine | Apple Silicon Mac |
| Python | 3.13.5 |
| Test file | ~60 lines Python |
| Cross-file test | 5 modules, ~300 lines total |

### Core Tools Comparison

| Tool | pyright-mcp (TS) | python-lsp-mcp (Rope) | python-lsp-mcp (Pyright) |
|------|------------------|----------------------|--------------------------|
| hover | 0.79 ms | 0.22 ms | 0.19 ms |
| definition | 0.39 ms | 0.15 ms | 0.14 ms |
| references | 7.85 ms | 19.70 ms | 19.37 ms |
| completions | 1.28 ms | 0.39 ms | 0.38 ms |
| symbols | 0.36 ms | 0.24 ms | 0.24 ms |
| signature_help | 0.62 ms | 0.15 ms | N/A |
| diagnostics | 347.49 ms | N/A | 266.60 ms |

### Rope-Only Tools

These tools are only available in the Python implementation:

| Tool | Mean | Notes |
|------|------|-------|
| search (ripgrep) | 5.99 ms | Fast file content search |
| function_signature | 0.15 ms | Get function parameter info |
| rename | N/A* | Cross-file symbol rename |
| move | N/A* | Move function/class to another module |
| change_signature | N/A* | Modify function parameters |

\* Refactoring tools modify files, not benchmarked for safety

### Cross-File Operations

Cross-file operations are critical for LLMs understanding codebase relationships:

| Operation | Rope Backend | Notes |
|-----------|--------------|-------|
| definition (cross-file) | 0.15 ms | Jump to definition in another module |
| references (cross-file) | 37.66 ms | Find all usages across 5 modules |
| hover (imported symbol) | 0.14 ms | Get docs for imported symbol |

### Analysis

- **All operations complete well under 1 second**, which is what matters for LLM use cases
- **Python implementation is generally faster** for hover, definition, completions, and symbols
- **TypeScript implementation has faster references** due to different index strategy
- **Diagnostics are slow** in both implementations (~300ms) because they run full type checking
- **Cross-file operations remain fast** thanks to Rope's project-level caching

## Running Benchmarks

```bash
# TypeScript
cd ts && bun run test:benchmark

# Python
cd python && uv run pytest tests/test_benchmark.py -v -s
```

---

*Last updated: 2026-01-24*
