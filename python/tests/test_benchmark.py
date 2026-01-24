"""Benchmark tests for Rope MCP Server."""

import json
import os
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pytest

from rope_mcp.tools import (
    get_completions,
    get_definition,
    get_hover,
    get_references,
    get_symbols,
)

# Fixtures directory (relative to python/tests/test_benchmark.py)
# Goes up: tests -> python -> PyLspMcp -> fixtures
FIXTURES_DIR = Path(__file__).parent.parent.parent / "fixtures"


@dataclass
class BenchmarkResult:
    """Result of a benchmark run."""

    tool: str
    iterations: int
    mean_ms: float
    std_ms: float
    min_ms: float
    max_ms: float
    success_rate: float


def run_benchmark(
    func: Callable,
    iterations: int = 10,
    warmup: int = 2,
) -> BenchmarkResult:
    """Run a benchmark for a given function.

    Args:
        func: Function to benchmark (should return dict with optional 'error' key)
        iterations: Number of iterations to run
        warmup: Number of warmup iterations (not counted)

    Returns:
        BenchmarkResult with timing statistics
    """
    # Warmup runs
    for _ in range(warmup):
        func()

    # Timed runs
    times = []
    successes = 0

    for _ in range(iterations):
        start = time.perf_counter()
        result = func()
        elapsed = (time.perf_counter() - start) * 1000  # Convert to ms

        times.append(elapsed)
        if isinstance(result, dict) and "error" not in result:
            successes += 1

    return BenchmarkResult(
        tool=func.__name__ if hasattr(func, "__name__") else "unknown",
        iterations=iterations,
        mean_ms=statistics.mean(times),
        std_ms=statistics.stdev(times) if len(times) > 1 else 0,
        min_ms=min(times),
        max_ms=max(times),
        success_rate=successes / iterations,
    )


class TestBenchmark:
    """Benchmark tests for all tools."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test fixtures."""
        self.test_file = str(FIXTURES_DIR / "test.py")
        self.cross_file = str(FIXTURES_DIR / "test_cross_file.py")
        self.utils_file = str(FIXTURES_DIR / "mypackage" / "utils.py")

        # Verify fixtures exist
        assert os.path.exists(self.test_file), f"Fixture not found: {self.test_file}"

    def test_benchmark_hover(self):
        """Benchmark hover tool."""
        # Position on Calculator class (line 19, col 7)
        result = run_benchmark(
            lambda: get_hover(self.test_file, 19, 7),
            iterations=20,
        )
        print(f"\n[Rope] Hover: {result.mean_ms:.2f}ms ± {result.std_ms:.2f}ms")
        assert result.success_rate >= 0.8, "Hover success rate too low"

    def test_benchmark_definition(self):
        """Benchmark definition tool."""
        # Position on self.value (line 27, col 14)
        result = run_benchmark(
            lambda: get_definition(self.test_file, 27, 14),
            iterations=20,
        )
        print(f"\n[Rope] Definition: {result.mean_ms:.2f}ms ± {result.std_ms:.2f}ms")
        assert result.success_rate >= 0.8, "Definition success rate too low"

    def test_benchmark_references(self):
        """Benchmark references tool."""
        # Find references to 'value' (line 23, col 14)
        result = run_benchmark(
            lambda: get_references(self.test_file, 23, 14),
            iterations=20,
        )
        print(f"\n[Rope] References: {result.mean_ms:.2f}ms ± {result.std_ms:.2f}ms")
        # References might not always find matches, so lower threshold
        assert result.success_rate >= 0.5, "References success rate too low"

    def test_benchmark_completions(self):
        """Benchmark completions tool."""
        # Position after 'self.' in add method (line 27, col 9)
        result = run_benchmark(
            lambda: get_completions(self.test_file, 27, 9),
            iterations=20,
        )
        print(f"\n[Rope] Completions: {result.mean_ms:.2f}ms ± {result.std_ms:.2f}ms")
        assert result.success_rate >= 0.8, "Completions success rate too low"

    def test_benchmark_symbols(self):
        """Benchmark symbols tool."""
        result = run_benchmark(
            lambda: get_symbols(self.test_file),
            iterations=20,
        )
        print(f"\n[Rope] Symbols: {result.mean_ms:.2f}ms ± {result.std_ms:.2f}ms")
        assert result.success_rate >= 0.9, "Symbols success rate too low"

    def test_benchmark_symbols_large_file(self):
        """Benchmark symbols on a larger file."""
        result = run_benchmark(
            lambda: get_symbols(self.utils_file),
            iterations=20,
        )
        print(f"\n[Rope] Symbols (large): {result.mean_ms:.2f}ms ± {result.std_ms:.2f}ms")

    def test_benchmark_summary(self):
        """Run all benchmarks and output summary."""
        results = []

        # Hover
        results.append(
            run_benchmark(lambda: get_hover(self.test_file, 19, 7), iterations=10)
        )
        results[-1] = BenchmarkResult(
            tool="hover", **{k: v for k, v in results[-1].__dict__.items() if k != "tool"}
        )

        # Definition
        results.append(
            run_benchmark(lambda: get_definition(self.test_file, 27, 14), iterations=10)
        )
        results[-1] = BenchmarkResult(
            tool="definition",
            **{k: v for k, v in results[-1].__dict__.items() if k != "tool"},
        )

        # References
        results.append(
            run_benchmark(lambda: get_references(self.test_file, 23, 14), iterations=10)
        )
        results[-1] = BenchmarkResult(
            tool="references",
            **{k: v for k, v in results[-1].__dict__.items() if k != "tool"},
        )

        # Completions
        results.append(
            run_benchmark(lambda: get_completions(self.test_file, 27, 9), iterations=10)
        )
        results[-1] = BenchmarkResult(
            tool="completions",
            **{k: v for k, v in results[-1].__dict__.items() if k != "tool"},
        )

        # Symbols
        results.append(
            run_benchmark(lambda: get_symbols(self.test_file), iterations=10)
        )
        results[-1] = BenchmarkResult(
            tool="symbols", **{k: v for k, v in results[-1].__dict__.items() if k != "tool"}
        )

        # Print summary table
        print("\n" + "=" * 70)
        print("ROPE MCP SERVER BENCHMARK SUMMARY")
        print("=" * 70)
        print(f"{'Tool':<15} {'Mean (ms)':<12} {'Std (ms)':<12} {'Min (ms)':<12} {'Max (ms)':<12}")
        print("-" * 70)

        for r in results:
            print(f"{r.tool:<15} {r.mean_ms:<12.2f} {r.std_ms:<12.2f} {r.min_ms:<12.2f} {r.max_ms:<12.2f}")

        print("=" * 70)

        # Output JSON for comparison
        output = {
            "implementation": "rope-mcp",
            "language": "Python",
            "results": [
                {
                    "tool": r.tool,
                    "mean_ms": round(r.mean_ms, 2),
                    "std_ms": round(r.std_ms, 2),
                    "min_ms": round(r.min_ms, 2),
                    "max_ms": round(r.max_ms, 2),
                    "success_rate": r.success_rate,
                }
                for r in results
            ],
        }
        print("\nJSON Output:")
        print(json.dumps(output, indent=2))


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
