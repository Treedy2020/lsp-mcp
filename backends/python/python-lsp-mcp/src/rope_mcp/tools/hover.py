"""Hover tool implementation - get documentation at position."""

from rope.contrib import codeassist

from ..rope_client import get_client


def get_hover(file: str, line: int, column: int) -> dict:
    """Get documentation for the symbol at the given position.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number

    Returns:
        Dict containing documentation or error message
    """
    client = get_client()

    try:
        workspace = client.find_workspace_for_file(file)
        project = client.get_project(workspace)
        resource = client.get_resource(project, file)
        source = resource.read()
        offset = client.position_to_offset(source, line, column)

        doc = codeassist.get_doc(project, source, offset, resource)

        if doc:
            return {
                "contents": doc,
                "file": file,
                "line": line,
                "column": column,
            }
        else:
            return {
                "contents": None,
                "message": "No documentation available at this position",
            }

    except Exception as e:
        return {
            "error": str(e),
            "file": file,
            "line": line,
            "column": column,
        }
