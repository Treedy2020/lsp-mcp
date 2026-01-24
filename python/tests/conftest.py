"""Pytest configuration and shared fixtures."""

import os
import tempfile
import pytest

from rope_mcp.config import get_config, Backend


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


@pytest.fixture
def setup_pyright_backend():
    """Set up Pyright as the backend for all tools."""
    config = get_config()
    original_backend = config.default_backend
    original_tools = config.tool_backends.copy()

    # Set Pyright as default
    config.set_all_backends(Backend.PYRIGHT)

    yield config

    # Restore original settings
    config.default_backend = original_backend
    config.tool_backends = original_tools
