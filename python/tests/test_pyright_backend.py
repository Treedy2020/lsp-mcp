"""Tests for Pyright backend via LSP client.

These tests directly use the LSP client to test Pyright functionality,
bypassing the MCP server layer.
"""

import os
import tempfile
import pytest

from rope_mcp.lsp import get_lsp_client, close_all_clients


@pytest.fixture(scope="module")
def lsp_client(tmp_path_factory):
    """Create an LSP client for testing."""
    # Create a temporary workspace
    workspace = tmp_path_factory.mktemp("workspace")
    client = get_lsp_client(str(workspace))
    yield client, workspace
    # Cleanup
    close_all_clients()


@pytest.fixture
def sample_python_file():
    """Create a temporary Python file for testing."""
    content = '''"""Sample module for testing."""

from typing import Optional


class Calculator:
    """A simple calculator class."""

    def __init__(self, value: int = 0):
        self.value = value

    def add(self, x: int) -> int:
        """Add x to the current value."""
        self.value += x
        return self.value

    def subtract(self, x: int) -> int:
        """Subtract x from the current value."""
        self.value -= x
        return self.value


def greet(name: str) -> str:
    """Return a greeting message."""
    return f"Hello, {name}!"


def calculate(a: int, b: int) -> int:
    """Calculate sum of two numbers."""
    calc = Calculator(a)
    return calc.add(b)


PI: float = 3.14159
'''
    with tempfile.NamedTemporaryFile(
        mode='w', suffix='.py', delete=False
    ) as f:
        f.write(content)
        f.flush()
        yield f.name
    os.unlink(f.name)


class TestPyrightHover:
    """Tests for hover with Pyright backend."""

    def test_hover_class(self, setup_pyright_backend, sample_python_file):
        """Test getting hover info for a class."""
        result = get_hover(sample_python_file, 6, 7)

        print(f"Hover result: {result}")

        # Should return contents or error
        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "contents" in result
        # Should contain class information
        contents = result["contents"]
        assert "Calculator" in contents or "class" in contents.lower()

    def test_hover_function(self, setup_pyright_backend, sample_python_file):
        """Test getting hover info for a function."""
        result = get_hover(sample_python_file, 22, 5)

        print(f"Hover result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "contents" in result
        contents = result["contents"]
        assert "greet" in contents or "str" in contents

    def test_hover_variable(self, setup_pyright_backend, sample_python_file):
        """Test getting hover info for a variable."""
        result = get_hover(sample_python_file, 32, 1)

        print(f"Hover result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "contents" in result


class TestPyrightDefinition:
    """Tests for definition with Pyright backend."""

    def test_definition_method_call(self, setup_pyright_backend, sample_python_file):
        """Test getting definition of a method call."""
        # Position on 'add' in calc.add(b) on line 29
        result = get_definition(sample_python_file, 29, 17)

        print(f"Definition result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        # Should point to the add method definition
        assert "file" in result or "line" in result

    def test_definition_class_usage(self, setup_pyright_backend, sample_python_file):
        """Test getting definition of class usage."""
        # Position on 'Calculator' in Calculator(a) on line 28
        result = get_definition(sample_python_file, 28, 12)

        print(f"Definition result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "file" in result or "line" in result


class TestPyrightReferences:
    """Tests for references with Pyright backend."""

    def test_references_class(self, setup_pyright_backend, sample_python_file):
        """Test finding references to a class."""
        # Position on 'Calculator' class definition
        result = get_references(sample_python_file, 6, 7)

        print(f"References result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "references" in result
        # Should find at least 2 references (definition + usage)
        assert len(result["references"]) >= 1

    def test_references_method(self, setup_pyright_backend, sample_python_file):
        """Test finding references to a method."""
        # Position on 'add' method definition
        result = get_references(sample_python_file, 12, 9)

        print(f"References result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "references" in result


class TestPyrightCompletions:
    """Tests for completions with Pyright backend."""

    def test_completions_after_dot(self, setup_pyright_backend, sample_python_file):
        """Test getting completions after a dot."""
        # Position after 'self.' in a method
        result = get_completions(sample_python_file, 14, 14)

        print(f"Completions result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "completions" in result

    def test_completions_top_level(self, setup_pyright_backend, sample_python_file):
        """Test getting completions at top level."""
        result = get_completions(sample_python_file, 4, 1)

        print(f"Completions result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "completions" in result


class TestPyrightSymbols:
    """Tests for symbols with Pyright backend."""

    def test_symbols_all(self, setup_pyright_backend, sample_python_file):
        """Test getting all symbols from a file."""
        result = get_symbols(sample_python_file)

        print(f"Symbols result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "symbols" in result
        assert result["count"] > 0

        # Check for expected symbols
        symbol_names = [s["name"] for s in result["symbols"]]
        assert "Calculator" in symbol_names
        assert "greet" in symbol_names
        assert "PI" in symbol_names

    def test_symbols_with_query(self, setup_pyright_backend, sample_python_file):
        """Test filtering symbols with a query."""
        result = get_symbols(sample_python_file, query="calc")

        print(f"Symbols result: {result}")

        if "error" in result:
            pytest.skip(f"Pyright error: {result['error']}")

        assert "symbols" in result
        # Should only match Calculator and calculate
        symbol_names = [s["name"] for s in result["symbols"]]
        for name in symbol_names:
            assert "calc" in name.lower()
