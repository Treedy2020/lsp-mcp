"""Move tool implementation - move function/class to another module."""

from rope.refactor.move import MoveGlobal

from ..rope_client import get_client
from ..lsp import refresh_lsp_documents


def do_move(
    file: str, line: int, column: int, destination: str, resources_only: bool = False
) -> dict:
    """Move a function or class to another module.

    Args:
        file: Absolute path to the Python file containing the symbol
        line: 1-based line number of the symbol
        column: 1-based column number of the symbol
        destination: Destination module path (e.g., "mypackage.utils" or "utils.py")
        resources_only: If True, only return what would change without applying

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

        # Create move refactoring
        mover = MoveGlobal(project, resource, offset)

        # Get the destination resource
        # Handle both module path (foo.bar) and file path (foo/bar.py)
        if destination.endswith(".py"):
            dest_resource = project.get_resource(destination)
        else:
            # Convert module path to file path
            dest_path = destination.replace(".", "/") + ".py"
            dest_resource = project.get_resource(dest_path)

        # Get the changes
        changes = mover.get_changes(dest_resource)

        # Collect the changes to report
        changed_files = []
        for change in changes.get_changed_resources():
            changed_files.append(change.real_path)

        if resources_only:
            return {
                "preview": True,
                "destination": destination,
                "changed_files": changed_files,
                "changes_count": len(changed_files),
            }

        # Apply the changes
        project.do(changes)

        # Refresh LSP documents so Pyright picks up the changes
        refresh_lsp_documents(changed_files)

        return {
            "success": True,
            "destination": destination,
            "changed_files": changed_files,
            "changes_count": len(changed_files),
        }

    except Exception as e:
        return {
            "error": str(e),
            "file": file,
            "line": line,
            "column": column,
            "destination": destination,
        }
