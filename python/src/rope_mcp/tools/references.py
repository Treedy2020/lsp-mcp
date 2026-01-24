"""References tool implementation - find all references."""

from rope.contrib import findit

from ..rope_client import get_client


def get_references(file: str, line: int, column: int) -> dict:
    """Find all references to the symbol at the given position.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number

    Returns:
        Dict containing list of references or error message
    """
    client = get_client()

    try:
        workspace = client.find_workspace_for_file(file)
        project = client.get_project(workspace)
        resource = client.get_resource(project, file)
        source = resource.read()
        offset = client.position_to_offset(source, line, column)

        occurrences = findit.find_occurrences(
            project, resource, offset, unsure=False, in_hierarchy=True
        )

        references = []
        for occurrence in occurrences:
            occ_resource = occurrence.resource
            occ_offset = occurrence.offset

            # Read source to convert offset to line/column
            occ_source = occ_resource.read()
            occ_line, occ_column = client.offset_to_position(occ_source, occ_offset)

            references.append(
                {
                    "file": occ_resource.real_path,
                    "line": occ_line,
                    "column": occ_column,
                }
            )

        return {
            "references": references,
            "count": len(references),
        }

    except Exception as e:
        return {
            "error": str(e),
            "file": file,
            "line": line,
            "column": column,
        }
