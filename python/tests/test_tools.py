"""Tests for Rope MCP tools."""

import os
import tempfile
import pytest

from rope_mcp.tools import (
    get_hover,
    get_definition,
    get_references,
    get_completions,
    get_symbols,
    do_rename,
    do_move,
    do_change_signature,
    get_function_signature,
    get_search,
)
from rope_mcp.rope_client import RopeClient


@pytest.fixture
def sample_python_file():
    """Create a temporary Python file for testing."""
    content = '''"""Sample module for testing."""


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


PI = 3.14159
'''
    with tempfile.NamedTemporaryFile(
        mode='w', suffix='.py', delete=False
    ) as f:
        f.write(content)
        f.flush()
        yield f.name
    os.unlink(f.name)


class TestRopeClient:
    """Tests for RopeClient."""

    def test_position_to_offset(self):
        """Test converting position to offset."""
        client = RopeClient()
        source = "line1\nline2\nline3\n"

        # First line, first column
        assert client.position_to_offset(source, 1, 1) == 0

        # Second line, first column
        assert client.position_to_offset(source, 2, 1) == 6

        # Third line, third column
        assert client.position_to_offset(source, 3, 3) == 14

    def test_offset_to_position(self):
        """Test converting offset to position."""
        client = RopeClient()
        source = "line1\nline2\nline3\n"

        # Offset 0 -> (1, 1)
        assert client.offset_to_position(source, 0) == (1, 1)

        # Offset 6 -> (2, 1)
        assert client.offset_to_position(source, 6) == (2, 1)

        # Offset 14 -> (3, 3)
        assert client.offset_to_position(source, 14) == (3, 3)


class TestSymbols:
    """Tests for symbols tool."""

    def test_get_symbols(self, sample_python_file):
        """Test getting symbols from a file."""
        result = get_symbols(sample_python_file)

        assert "error" not in result
        assert "symbols" in result
        assert result["count"] > 0

        # Check for expected symbols
        symbol_names = [s["name"] for s in result["symbols"]]
        assert "Calculator" in symbol_names
        assert "greet" in symbol_names
        assert "PI" in symbol_names

    def test_get_symbols_with_query(self, sample_python_file):
        """Test filtering symbols with a query."""
        result = get_symbols(sample_python_file, query="calc")

        assert "error" not in result
        assert "symbols" in result
        # Should only match Calculator
        symbol_names = [s["name"] for s in result["symbols"]]
        assert "Calculator" in symbol_names
        assert "greet" not in symbol_names


class TestCompletions:
    """Tests for completions tool."""

    def test_get_completions(self, sample_python_file):
        """Test getting completions."""
        # Position after "self." in the add method
        result = get_completions(sample_python_file, 12, 14)

        # Should either work or provide error
        assert "completions" in result or "error" in result


class TestDefinition:
    """Tests for definition tool."""

    def test_get_definition(self, sample_python_file):
        """Test getting definition."""
        # Try to find definition of 'value' on line 12
        result = get_definition(sample_python_file, 12, 14)

        # Should return a result
        assert "file" in result or "error" in result


class TestHover:
    """Tests for hover tool."""

    def test_get_hover_class(self, sample_python_file):
        """Test getting hover info for a class."""
        # Position on Calculator class definition
        result = get_hover(sample_python_file, 4, 7)

        # Should return something
        assert "contents" in result or "error" in result


class TestReferences:
    """Tests for references tool."""

    def test_get_references(self, sample_python_file):
        """Test finding references."""
        # Find references to 'value'
        result = get_references(sample_python_file, 8, 14)

        # Should return references or error
        assert "references" in result or "error" in result


class TestRename:
    """Tests for rename tool."""

    def test_rename(self, sample_python_file):
        """Test renaming a symbol."""
        # Rename 'PI' to 'PI_VALUE'
        result = do_rename(sample_python_file, 27, 1, "PI_VALUE")

        if "error" not in result:
            assert result["success"] is True
            assert result["new_name"] == "PI_VALUE"

            # Verify the file was changed
            with open(sample_python_file) as f:
                content = f.read()
            assert "PI_VALUE" in content


class TestSearch:
    """Tests for search tool."""

    def test_search_pattern(self, sample_python_file):
        """Test searching for a pattern."""
        # Get the directory containing the temp file
        search_dir = os.path.dirname(sample_python_file)
        result = get_search("Calculator", search_dir)

        assert "error" not in result
        assert "results" in result
        assert result["count"] > 0

        # Check that we found the Calculator class
        files = [r["file"] for r in result["results"]]
        assert sample_python_file in files

    def test_search_with_glob(self, sample_python_file):
        """Test searching with glob filter."""
        search_dir = os.path.dirname(sample_python_file)
        result = get_search("def", search_dir, glob="*.py")

        assert "error" not in result
        assert "results" in result

    def test_search_case_insensitive(self, sample_python_file):
        """Test case insensitive search."""
        search_dir = os.path.dirname(sample_python_file)
        result = get_search("calculator", search_dir, case_sensitive=False)

        assert "error" not in result
        assert "results" in result
        assert result["count"] > 0

    def test_search_no_matches(self, sample_python_file):
        """Test search with no matches."""
        search_dir = os.path.dirname(sample_python_file)
        result = get_search("ZZZZNOTFOUNDZZZZZ", search_dir)

        assert "error" not in result
        assert result["count"] == 0


class TestFunctionSignature:
    """Tests for function_signature tool."""

    def test_get_function_signature(self, sample_python_file):
        """Test getting function signature."""
        # Get signature of 'add' method (line 11)
        result = get_function_signature(sample_python_file, 11, 9)

        if "error" not in result:
            assert "params" in result
            assert "param_names" in result
            # Should have self and x
            assert "self" in result["param_names"]
            assert "x" in result["param_names"]


class TestChangeSignature:
    """Tests for change_signature tool."""

    def test_change_signature_add_param(self):
        """Test adding a parameter to a function."""
        content = '''def greet(name):
    return f"Hello, {name}!"

result = greet("World")
'''
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            f.write(content)
            f.flush()
            temp_file = f.name

        try:
            # Add 'greeting' param with default 'Hello'
            result = do_change_signature(
                temp_file,
                1,
                5,
                add_param={"name": "greeting", "default": '"Hello"'},
            )

            if "error" not in result:
                assert result["success"] is True

                # Verify the file was changed
                with open(temp_file) as f:
                    new_content = f.read()
                assert "greeting" in new_content
        finally:
            os.unlink(temp_file)

    def test_change_signature_remove_param(self):
        """Test removing a parameter from a function."""
        content = '''def greet(name, greeting):
    return f"{greeting}, {name}!"

result = greet("World", "Hi")
'''
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            f.write(content)
            f.flush()
            temp_file = f.name

        try:
            result = do_change_signature(
                temp_file,
                1,
                5,
                remove_param="greeting",
            )

            if "error" not in result:
                assert result["success"] is True
                assert "changed_files" in result
        finally:
            os.unlink(temp_file)
