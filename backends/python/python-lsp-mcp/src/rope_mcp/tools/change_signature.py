"""Change signature tool implementation - modify function parameters."""

from typing import Optional

from rope.refactor.change_signature import ChangeSignature, ArgumentNormalizer

from ..rope_client import get_client
from ..lsp import refresh_lsp_documents


def do_change_signature(
    file: str,
    line: int,
    column: int,
    new_params: Optional[list[str]] = None,
    add_param: Optional[dict] = None,
    remove_param: Optional[str] = None,
    resources_only: bool = False,
) -> dict:
    """Change the signature of a function.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number of the function
        column: 1-based column number of the function
        new_params: Complete new parameter list (reorder/rename), e.g. ["self", "b", "a"]
        add_param: Add a parameter, e.g. {"name": "new_param", "default": "None", "index": 1}
        remove_param: Name of parameter to remove
        resources_only: If True, only return what would change without applying

    Returns:
        Dict containing the changes made or error message

    Examples:
        # Reorder parameters: def foo(a, b) -> def foo(b, a)
        change_signature(file, line, col, new_params=["self", "b", "a"])

        # Add parameter: def foo(a) -> def foo(a, b=None)
        change_signature(file, line, col, add_param={"name": "b", "default": "None"})

        # Remove parameter: def foo(a, b) -> def foo(a)
        change_signature(file, line, col, remove_param="b")
    """
    client = get_client()

    try:
        workspace = client.find_workspace_for_file(file)
        project = client.get_project(workspace)
        resource = client.get_resource(project, file)
        source = resource.read()
        offset = client.position_to_offset(source, line, column)

        # Create change signature refactoring
        changer = ChangeSignature(project, resource, offset)

        # Get current signature info
        signature = changer.get_args()
        original_params = [arg[0] for arg in signature]  # Extract param names

        # Build the changers list
        changers = []

        if new_params is not None:
            # Reorder/rename parameters
            # ArgumentNormalizer reorders arguments to match new order
            changers.append(ArgumentNormalizer(new_params))  # type: ignore[call-arg]

        if add_param is not None:
            # Add a new parameter
            from rope.refactor.change_signature import ArgumentAdder

            name = add_param.get("name")
            default = add_param.get("default")
            index = add_param.get("index")
            # If index is None, append at the end
            if index is None:
                index = len(original_params)
            changers.append(ArgumentAdder(index, name, default))

        if remove_param is not None:
            # Remove a parameter
            from rope.refactor.change_signature import ArgumentRemover

            # Find the index of the parameter to remove
            try:
                param_index = original_params.index(remove_param)
                changers.append(ArgumentRemover(param_index))
            except ValueError:
                return {
                    "error": f"Parameter '{remove_param}' not found in function signature",
                    "current_params": original_params,
                }

        if not changers:
            return {
                "error": "No changes specified. Use new_params, add_param, or remove_param.",
                "current_params": original_params,
            }

        # Get the changes
        changes = changer.get_changes(changers)

        # Collect the changes to report
        changed_files = []
        for change in changes.get_changed_resources():
            changed_files.append(change.real_path)

        if resources_only:
            return {
                "preview": True,
                "original_params": original_params,
                "changed_files": changed_files,
                "changes_count": len(changed_files),
            }

        # Apply the changes
        project.do(changes)

        # Refresh LSP documents so Pyright picks up the changes
        refresh_lsp_documents(changed_files)

        return {
            "success": True,
            "original_params": original_params,
            "changed_files": changed_files,
            "changes_count": len(changed_files),
        }

    except Exception as e:
        return {
            "error": str(e),
            "file": file,
            "line": line,
            "column": column,
        }


def get_function_signature(file: str, line: int, column: int) -> dict:
    """Get the current signature of a function.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number of the function
        column: 1-based column number of the function

    Returns:
        Dict containing the function signature info
    """
    client = get_client()

    try:
        workspace = client.find_workspace_for_file(file)
        project = client.get_project(workspace)
        resource = client.get_resource(project, file)
        source = resource.read()
        offset = client.position_to_offset(source, line, column)

        # Create change signature refactoring to inspect signature
        changer = ChangeSignature(project, resource, offset)

        # Get current signature info
        # Returns list of tuples: [(name, default_value), ...]
        signature = changer.get_args()

        params = []
        for arg in signature:
            param_info = {"name": arg[0]}
            if len(arg) > 1 and arg[1] is not None:
                param_info["default"] = arg[1]
            params.append(param_info)

        return {
            "params": params,
            "param_names": [p["name"] for p in params],
            "count": len(params),
        }

    except Exception as e:
        return {
            "error": str(e),
            "file": file,
            "line": line,
            "column": column,
        }
