"""Symbols tool implementation - document/workspace symbols."""

import ast
from typing import Optional


def get_symbols(file: str, query: Optional[str] = None) -> dict:
    """Get symbols from a Python file.

    Args:
        file: Absolute path to the Python file
        query: Optional filter query for symbol names

    Returns:
        Dict containing list of symbols or error message
    """
    try:
        # Read file directly - no need for Rope for AST parsing
        with open(file, encoding="utf-8") as f:
            source = f.read()

        # Parse the AST to extract symbols
        tree = ast.parse(source, filename=file)
        symbols = _extract_symbols(tree, file)

        # Filter by query if provided
        if query:
            query_lower = query.lower()
            symbols = [s for s in symbols if query_lower in s["name"].lower()]

        return {
            "symbols": symbols,
            "count": len(symbols),
            "file": file,
        }

    except SyntaxError as e:
        return {
            "error": f"Syntax error: {e}",
            "file": file,
        }
    except Exception as e:
        return {
            "error": str(e),
            "file": file,
        }


def _extract_symbols(tree: ast.AST, file_path: str) -> list[dict]:
    """Extract symbols from an AST."""
    symbols = []

    for node in ast.walk(tree):
        symbol = None

        if isinstance(node, ast.ClassDef):
            symbol = {
                "name": node.name,
                "kind": "Class",
                "line": node.lineno,
                "column": node.col_offset + 1,
                "end_line": node.end_lineno,
                "file": file_path,
            }
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            # Check if it's a method (inside a class)
            kind = "Function"
            symbol = {
                "name": node.name,
                "kind": kind,
                "line": node.lineno,
                "column": node.col_offset + 1,
                "end_line": node.end_lineno,
                "file": file_path,
            }
        elif isinstance(node, ast.Assign):
            # Module-level variable assignments
            if isinstance(node, ast.Assign) and node.col_offset == 0:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        symbol = {
                            "name": target.id,
                            "kind": "Variable",
                            "line": node.lineno,
                            "column": node.col_offset + 1,
                            "file": file_path,
                        }
                        symbols.append(symbol)
                continue
        elif isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.asname or alias.name
                symbol = {
                    "name": name,
                    "kind": "Module",
                    "line": node.lineno,
                    "column": node.col_offset + 1,
                    "file": file_path,
                }
                symbols.append(symbol)
            continue
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                name = alias.asname or alias.name
                symbol = {
                    "name": name,
                    "kind": "Module",
                    "line": node.lineno,
                    "column": node.col_offset + 1,
                    "file": file_path,
                }
                symbols.append(symbol)
            continue

        if symbol:
            symbols.append(symbol)

    return symbols
