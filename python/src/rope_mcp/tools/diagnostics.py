"""Diagnostics tool implementation using Pyright."""

from ..pyright_client import get_pyright_client


def get_diagnostics(path: str) -> dict:
    """Get diagnostics (type errors, warnings) for a file or directory.

    This tool uses Pyright for type checking and analysis.

    Args:
        path: Absolute path to a Python file or directory

    Returns:
        Dict containing diagnostics or error message
    """
    client = get_pyright_client()
    return client.get_diagnostics(path)
