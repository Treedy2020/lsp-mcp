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
| **Rename refactoring** | Excellent | Good |
| **Diagnostics** | N/A | Full |
| **Setup** | Zero config | Zero config |

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

### Results

| Tool | pyright-mcp (TS) | python-lsp-mcp (Rope) |
|------|------------------|----------------------|
| hover | 0.79 ms | 0.16 ms |
| definition | 0.40 ms | 0.12 ms |
| references | 8.11 ms | 14.20 ms |
| completions | 1.52 ms | 0.36 ms |
| symbols | 0.44 ms | 0.24 ms |

All operations complete well under 1 second, which is what matters for LLM use cases.

## Running Benchmarks

```bash
# TypeScript
cd ts && bun run test:benchmark

# Python
cd python && uv run pytest tests/test_benchmark.py -v -s
```

---

*Last updated: 2026-01-24*
