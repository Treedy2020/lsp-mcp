"""Rename tool implementation - rename refactoring."""

from rope.refactor.rename import Rename

from ..rope_client import get_client


def do_rename(file: str, line: int, column: int, new_name: str) -> dict:
    """Rename the symbol at the given position.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number
        new_name: The new name for the symbol

    Returns:
        Dict containing the changes made or error message
    """
    client = get_client()

    try:
        workspace = client.find_workspace_for_file(file)
        project = client.get_project(workspace)
        resource = client.get_resource(project, file)
        source = resource.read()
        offset = client.position_to_offset(source, line, column)

        # Create rename refactoring
        renamer = Rename(project, resource, offset)

        # Get the changes
        changes = renamer.get_changes(new_name)

        # Collect the changes to report
        changed_files = []
        for change in changes.get_changed_resources():
            changed_files.append(change.real_path)

        # Apply the changes
        project.do(changes)

        return {
            "success": True,
            "new_name": new_name,
            "changed_files": changed_files,
            "changes_count": len(changed_files),
        }

    except Exception as e:
        return {
            "error": str(e),
            "file": file,
            "line": line,
            "column": column,
            "new_name": new_name,
        }
