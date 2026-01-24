"""Definition tool implementation - go to definition."""

from rope.contrib import codeassist

from ..rope_client import get_client


def get_definition(file: str, line: int, column: int) -> dict:
    """Get the definition location for the symbol at the given position.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number

    Returns:
        Dict containing definition location or error message
    """
    client = get_client()

    try:
        workspace = client.find_workspace_for_file(file)
        project = client.get_project(workspace)
        resource = client.get_resource(project, file)
        source = resource.read()
        offset = client.position_to_offset(source, line, column)

        location = codeassist.get_definition_location(
            project, source, offset, resource
        )

        if location and location[0] is not None:
            def_resource, def_line = location
            def_path = def_resource.real_path if def_resource else file

            return {
                "file": def_path,
                "line": def_line or 1,
                "column": 1,  # Rope doesn't provide column info
            }
        else:
            return {
                "file": None,
                "message": "No definition found at this position",
            }

    except Exception as e:
        return {
            "error": str(e),
            "file": file,
            "line": line,
            "column": column,
        }
