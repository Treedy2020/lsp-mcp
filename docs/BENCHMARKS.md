# Benchmark Results

This document contains detailed performance benchmarks for PyLspMcp implementations.

## Quick Summary

| Tool | pyright-mcp (TS) | python-lsp-mcp (Python) | Winner | Speedup |
|------|------------------|-------------------|--------|---------|
| hover | 0.79 ms | **0.16 ms** | python-lsp-mcp | 4.9x |
| definition | 0.40 ms | **0.12 ms** | python-lsp-mcp | 3.3x |
| references | **8.11 ms** | 14.20 ms | pyright-mcp | 1.8x |
| completions | 1.52 ms | **0.36 ms** | python-lsp-mcp | 4.2x |
| symbols | 0.44 ms | **0.24 ms** | python-lsp-mcp | 1.8x |

## Test Environment

| Property | Value |
|----------|-------|
| Machine | Apple Silicon Mac |
| OS | macOS Darwin 24.6.0 |
| Python | 3.13.5 |
| Node.js | 18+ |
| Rope | 1.13.0 |
| Pyright | 1.1.408 |

## Test Configuration

- **Iterations**: 20 (with 2 warmup)
- **Test file**: `fixtures/test.py` (~60 lines)
- **Metrics**: Mean, Std Dev, Min, Max (milliseconds)

## Detailed Results

### pyright-mcp (TypeScript)

```
======================================================================
PYRIGHT MCP SERVER BENCHMARK SUMMARY
======================================================================
Tool            Mean (ms)    Std (ms)     Min (ms)     Max (ms)
----------------------------------------------------------------------
hover           0.79         0.46         0.36         1.99
definition      0.40         0.08         0.30         0.61
references      8.11         0.63         6.95         9.31
completions     1.52         0.51         0.86         2.97
symbols         0.44         0.11         0.35         0.90
diagnostics     334.27       9.02         322.77       360.36
signature_help  0.47         0.46         0.29         2.44
======================================================================
```

### python-lsp-mcp (Python)

```
======================================================================
ROPE MCP SERVER BENCHMARK SUMMARY
======================================================================
Tool            Mean (ms)    Std (ms)     Min (ms)     Max (ms)
----------------------------------------------------------------------
hover           0.16         0.01         0.15         0.19
definition      0.12         0.00         0.12         0.12
references      14.20        0.39         13.73        14.86
completions     0.36         0.02         0.34         0.40
symbols         0.24         0.01         0.24         0.25
======================================================================
```

## Running Benchmarks

### TypeScript (pyright-mcp)

```bash
cd ts
bun run build
bun run test:benchmark
```

### Python (python-lsp-mcp)

```bash
cd python
uv run pytest tests/test_benchmark.py -v -s
```

Summary only:

```bash
uv run pytest tests/test_benchmark.py::TestBenchmark::test_benchmark_summary -v -s
```

## Test Positions

| Test | File | Line | Column | Target |
|------|------|------|--------|--------|
| hover | test.py | 19 | 7 | Calculator class |
| definition | test.py | 27 | 14 | self.value |
| references | test.py | 23 | 14 | value attribute |
| completions | test.py | 27 | 9 | after `self.` |
| symbols | test.py | - | - | entire file |

## Analysis

### Startup Time

| Implementation | Cold Start | Warm Calls |
|----------------|------------|------------|
| pyright-mcp | ~1-2s (LSP init) | Fast |
| python-lsp-mcp | ~0.1s | Very fast |

### Memory Usage

| Implementation | Idle | Active |
|----------------|------|--------|
| pyright-mcp | Higher (separate process) | ~200-400MB |
| python-lsp-mcp | Lower (in-process) | ~50-100MB |

### Consistency

| Implementation | Std Dev Pattern |
|----------------|-----------------|
| pyright-mcp | Higher variance (0.08-0.63ms) |
| python-lsp-mcp | Very consistent (0.00-0.39ms) |

## Trade-offs

### Speed vs Accuracy

| Scenario | Recommendation |
|----------|----------------|
| Type-heavy projects | pyright-mcp |
| Quick refactoring | python-lsp-mcp |
| Large codebases | pyright-mcp |
| Low latency needed | python-lsp-mcp |
| Need diagnostics | pyright-mcp |
| CI/CD pipelines | python-lsp-mcp |

### Feature Comparison

| Feature | pyright-mcp | python-lsp-mcp |
|---------|-------------|----------|
| Type inference | Excellent | Limited |
| Cross-file analysis | Excellent | Good |
| Diagnostics | Full | None |
| Rename refactoring | Good | Excellent |
| Performance | Good | Excellent |
| Memory efficiency | Moderate | High |

## JSON Output

### pyright-mcp

```json
{
  "implementation": "pyright-mcp",
  "language": "TypeScript",
  "results": [
    {"tool": "hover", "mean_ms": 0.79, "std_ms": 0.46, "min_ms": 0.36, "max_ms": 1.99, "success_rate": 1},
    {"tool": "definition", "mean_ms": 0.4, "std_ms": 0.08, "min_ms": 0.3, "max_ms": 0.61, "success_rate": 1},
    {"tool": "references", "mean_ms": 8.11, "std_ms": 0.63, "min_ms": 6.95, "max_ms": 9.31, "success_rate": 1},
    {"tool": "completions", "mean_ms": 1.52, "std_ms": 0.51, "min_ms": 0.86, "max_ms": 2.97, "success_rate": 1},
    {"tool": "symbols", "mean_ms": 0.44, "std_ms": 0.11, "min_ms": 0.35, "max_ms": 0.9, "success_rate": 1},
    {"tool": "diagnostics", "mean_ms": 334.27, "std_ms": 9.02, "min_ms": 322.77, "max_ms": 360.36, "success_rate": 1},
    {"tool": "signature_help", "mean_ms": 0.47, "std_ms": 0.46, "min_ms": 0.29, "max_ms": 2.44, "success_rate": 1}
  ]
}
```

### python-lsp-mcp

```json
{
  "implementation": "python-lsp-mcp",
  "language": "Python",
  "results": [
    {"tool": "hover", "mean_ms": 0.16, "std_ms": 0.01, "min_ms": 0.15, "max_ms": 0.19, "success_rate": 1.0},
    {"tool": "definition", "mean_ms": 0.12, "std_ms": 0.0, "min_ms": 0.12, "max_ms": 0.12, "success_rate": 1.0},
    {"tool": "references", "mean_ms": 14.2, "std_ms": 0.39, "min_ms": 13.73, "max_ms": 14.86, "success_rate": 1.0},
    {"tool": "completions", "mean_ms": 0.36, "std_ms": 0.02, "min_ms": 0.34, "max_ms": 0.4, "success_rate": 1.0},
    {"tool": "symbols", "mean_ms": 0.24, "std_ms": 0.01, "min_ms": 0.24, "max_ms": 0.25, "success_rate": 1.0}
  ]
}
```

## Historical Data

| Date | Version | Tool | Mean (ms) | Notes |
|------|---------|------|-----------|-------|
| 2025-01-24 | 0.2.0 | hover | 0.16 | Initial Rope benchmark |
| 2025-01-24 | 0.2.0 | definition | 0.12 | Initial Rope benchmark |
| 2025-01-24 | 0.2.0 | references | 14.20 | Initial Rope benchmark |
| 2025-01-24 | 0.2.0 | completions | 0.36 | Initial Rope benchmark |
| 2025-01-24 | 0.2.0 | symbols | 0.24 | Initial Rope benchmark |

---

*Last updated: 2025-01-24*
