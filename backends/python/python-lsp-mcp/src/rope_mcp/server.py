"""MCP Server for Python code analysis using Rope and Pyright."""

import atexit
import json
import os
import sys
import threading
from importlib.metadata import version as pkg_version
from typing import Literal, Optional

from mcp.server.fastmcp import FastMCP

# Get package version at runtime
try:
    __version__ = pkg_version("python-lsp-mcp")
except Exception:
    __version__ = "0.3.0"  # Fallback

from .config import (
    Backend,
    get_config,
    SHARED_TOOLS,
    set_python_path as config_set_python_path,
    get_python_path_status,
    set_active_workspace,
    get_active_workspace,
    validate_file_workspace,
)
from .rope_client import get_client as get_rope_client
from .lsp import get_lsp_client, close_all_clients, close_all_clients as close_lsp_clients
from .tools import (
    do_rename,
    do_move,
    do_change_signature,
    get_function_signature,
    get_completions as rope_completions,
    get_definition as rope_definition,
    get_hover as rope_hover,
    get_references as rope_references,
    get_symbols as rope_symbols,
    get_diagnostics,
    get_search,
)

# Create the MCP server
mcp = FastMCP("python-lsp-mcp")

# Register cleanup on exit
atexit.register(close_all_clients)


@mcp.tool()
def switch_workspace(path: str) -> str:
    """Switch the active workspace to a new project directory.

    This will:
    1. Set the new active workspace path.
    2. Close all existing language server instances to save resources.
    3. The next tool call will start a new language server for the new workspace.

    Args:
        path: Absolute path to the new project root directory.

    Returns:
        JSON string with confirmation of the switch.
    """
    abs_path = os.path.abspath(path)
    if not os.path.isdir(abs_path):
        return json.dumps(
            {"error": "Invalid Path", "message": f"'{path}' is not a directory."},
            indent=2,
        )

    # Close all existing clients (LSP and Rope)
    close_lsp_clients()
    get_rope_client().close_all()

    # Set new active workspace
    new_workspace = set_active_workspace(abs_path)

    return json.dumps(
        {
            "success": True,
            "message": f"Switched active workspace to: {new_workspace}",
            "workspace": new_workspace,
            "info": "All previous language server instances have been closed.",
        },
        indent=2,
    )


def _find_workspace(file_path: str) -> str:
    """Find workspace root for a file."""
    # If we have an active workspace, always use it
    active = get_active_workspace()
    if active:
        return active

    client = get_rope_client()
    return client.find_workspace_for_file(file_path)


def _get_effective_backend(tool: str, backend: Optional[str]) -> Backend:
    """Get the effective backend for a tool."""
    if backend:
        try:
            return Backend(backend.lower())
        except ValueError:
            pass
    return get_config().get_backend_for(tool)


@mcp.tool()
def hover(
    file: str,
    line: int,
    column: int,
    backend: Optional[Literal["rope", "pyright"]] = None,
) -> str:
    """Get documentation for the symbol at the given position.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number
        backend: Backend to use (rope/pyright). Default: from config or 'rope'

    Returns:
        JSON string with documentation or error message
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    effective_backend = _get_effective_backend("hover", backend)

    if effective_backend == Backend.PYRIGHT:
        try:
            workspace = _find_workspace(file)
            client = get_lsp_client(workspace)
            result = client.hover(file, line, column)
            if result:
                return json.dumps(
                    {"contents": result.get("contents", ""), "backend": "pyright"},
                    indent=2,
                )
            return json.dumps(
                {"contents": None, "message": "No hover info", "backend": "pyright"},
                indent=2,
            )
        except Exception as e:
            return json.dumps({"error": str(e), "backend": "pyright"}, indent=2)
    else:
        result = rope_hover(file, line, column)
        result["backend"] = "rope"
        return json.dumps(result, indent=2)


@mcp.tool()
def definition(
    file: str,
    line: int,
    column: int,
    backend: Optional[Literal["rope", "pyright"]] = None,
) -> str:
    """Get the definition location for the symbol at the given position.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number
        backend: Backend to use (rope/pyright). Default: from config or 'rope'

    Returns:
        JSON string with definition location or error message
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    effective_backend = _get_effective_backend("definition", backend)

    if effective_backend == Backend.PYRIGHT:
        try:
            workspace = _find_workspace(file)
            client = get_lsp_client(workspace)
            locations = client.definition(file, line, column)
            if locations:
                result = locations[0]
                result["backend"] = "pyright"
                return json.dumps(result, indent=2)
            return json.dumps(
                {"file": None, "message": "No definition found", "backend": "pyright"},
                indent=2,
            )
        except Exception as e:
            return json.dumps({"error": str(e), "backend": "pyright"}, indent=2)
    else:
        result = rope_definition(file, line, column)
        result["backend"] = "rope"
        return json.dumps(result, indent=2)


@mcp.tool()
def references(
    file: str,
    line: int,
    column: int,
    backend: Optional[Literal["rope", "pyright"]] = None,
) -> str:
    """Find all references to the symbol at the given position.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number
        backend: Backend to use (rope/pyright). Default: from config or 'rope'

    Returns:
        JSON string with list of references or error message
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    effective_backend = _get_effective_backend("references", backend)

    if effective_backend == Backend.PYRIGHT:
        try:
            workspace = _find_workspace(file)
            client = get_lsp_client(workspace)
            refs = client.references(file, line, column)
            return json.dumps(
                {"references": refs, "count": len(refs), "backend": "pyright"}, indent=2
            )
        except Exception as e:
            return json.dumps({"error": str(e), "backend": "pyright"}, indent=2)
    else:
        result = rope_references(file, line, column)
        result["backend"] = "rope"
        return json.dumps(result, indent=2)


@mcp.tool()
def completions(
    file: str,
    line: int,
    column: int,
    backend: Optional[Literal["rope", "pyright"]] = None,
) -> str:
    """Get code completion suggestions at the given position.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number
        backend: Backend to use (rope/pyright). Default: from config or 'rope'

    Returns:
        JSON string with completion items or error message
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    effective_backend = _get_effective_backend("completions", backend)

    if effective_backend == Backend.PYRIGHT:
        try:
            workspace = _find_workspace(file)
            client = get_lsp_client(workspace)
            items = client.completions(file, line, column)
            return json.dumps(
                {"completions": items, "count": len(items), "backend": "pyright"},
                indent=2,
            )
        except Exception as e:
            return json.dumps({"error": str(e), "backend": "pyright"}, indent=2)
    else:
        result = rope_completions(file, line, column)
        result["backend"] = "rope"
        return json.dumps(result, indent=2)


@mcp.tool()
def symbols(
    file: str,
    query: Optional[str] = None,
    backend: Optional[Literal["rope", "pyright"]] = None,
) -> str:
    """Get symbols from a Python file.

    Args:
        file: Absolute path to the Python file
        query: Optional filter query for symbol names
        backend: Backend to use (rope/pyright). Default: from config or 'rope'

    Returns:
        JSON string with list of symbols or error message
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    effective_backend = _get_effective_backend("symbols", backend)

    if effective_backend == Backend.PYRIGHT:
        try:
            workspace = _find_workspace(file)
            client = get_lsp_client(workspace)
            syms = client.document_symbols(file)
            # Filter by query if provided
            if query:
                query_lower = query.lower()
                syms = [s for s in syms if query_lower in s["name"].lower()]
            return json.dumps(
                {
                    "symbols": syms,
                    "count": len(syms),
                    "file": file,
                    "backend": "pyright",
                },
                indent=2,
            )
        except Exception as e:
            return json.dumps({"error": str(e), "backend": "pyright"}, indent=2)
    else:
        result = rope_symbols(file, query)
        result["backend"] = "rope"
        return json.dumps(result, indent=2)


@mcp.tool()
def rename(file: str, line: int, column: int, new_name: str) -> str:
    """Rename the symbol at the given position.

    This will modify files on disk to rename all occurrences of the symbol.
    Uses Rope backend for best refactoring support.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number
        new_name: The new name for the symbol

    Returns:
        JSON string with changes made or error message
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    result = do_rename(file, line, column, new_name)
    result["backend"] = "rope"
    return json.dumps(result, indent=2)


@mcp.tool()
def move(
    file: str,
    line: int,
    column: int,
    destination: str,
    preview: bool = False,
) -> str:
    """Move a function or class to another module.

    This will modify files on disk to move the symbol and update all imports.
    Uses Rope backend for refactoring.

    Args:
        file: Absolute path to the Python file containing the symbol
        line: 1-based line number of the symbol to move
        column: 1-based column number of the symbol
        destination: Destination module path (e.g., "mypackage.utils" or "utils.py")
        preview: If True, only show what would change without applying

    Returns:
        JSON string with changes made or error message
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    result = do_move(file, line, column, destination, resources_only=preview)
    result["backend"] = "rope"
    return json.dumps(result, indent=2)


@mcp.tool()
def change_signature(
    file: str,
    line: int,
    column: int,
    new_params: Optional[list[str]] = None,
    add_param: Optional[str] = None,
    add_param_default: Optional[str] = None,
    add_param_index: Optional[int] = None,
    remove_param: Optional[str] = None,
    preview: bool = False,
) -> str:
    """Change the signature of a function.

    This will modify files on disk to update the function and all call sites.
    Uses Rope backend for refactoring.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number of the function
        column: 1-based column number of the function
        new_params: New parameter order, e.g. ["self", "b", "a"] to reorder
        add_param: Name of parameter to add
        add_param_default: Default value for added parameter
        add_param_index: Index where to insert new param (None = append)
        remove_param: Name of parameter to remove
        preview: If True, only show what would change without applying

    Returns:
        JSON string with changes made or error message

    Examples:
        # Reorder: def foo(a, b) -> def foo(b, a)
        change_signature(file, line, col, new_params=["self", "b", "a"])

        # Add param: def foo(a) -> def foo(a, b=None)
        change_signature(file, line, col, add_param="b", add_param_default="None")

        # Remove param: def foo(a, b) -> def foo(a)
        change_signature(file, line, col, remove_param="b")
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    # Build add_param dict if specified
    add_param_dict = None
    if add_param:
        add_param_dict = {
            "name": add_param,
            "default": add_param_default,
            "index": add_param_index,
        }

    result = do_change_signature(
        file,
        line,
        column,
        new_params=new_params,
        add_param=add_param_dict,
        remove_param=remove_param,
        resources_only=preview,
    )
    result["backend"] = "rope"
    return json.dumps(result, indent=2)


@mcp.tool()
def function_signature(file: str, line: int, column: int) -> str:
    """Get the current signature of a function.

    Useful for inspecting function parameters before changing the signature.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number of the function
        column: 1-based column number of the function

    Returns:
        JSON string with function signature info
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    result = get_function_signature(file, line, column)
    result["backend"] = "rope"
    return json.dumps(result, indent=2)


@mcp.tool()
def diagnostics(path: str) -> str:
    """Get type errors and warnings for a Python file or directory.

    Uses Pyright for type checking. Requires Pyright to be installed.

    Args:
        path: Absolute path to a Python file or directory

    Returns:
        JSON string with diagnostics or error message
    """
    # Guard: check workspace
    error = validate_file_workspace(path)
    if error:
        return json.dumps(error, indent=2)

    result = get_diagnostics(path)
    result["backend"] = "pyright"
    return json.dumps(result, indent=2)


@mcp.tool()
def signature_help(file: str, line: int, column: int) -> str:
    """Get function signature information at the given position.

    Uses Pyright backend for accurate signature information.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number

    Returns:
        JSON string with signature help or error message
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    try:
        workspace = _find_workspace(file)
        client = get_lsp_client(workspace)
        result = client.signature_help(file, line, column)
        if result:
            result["backend"] = "pyright"
            return json.dumps(result, indent=2)
        return json.dumps(
            {"message": "No signature help available", "backend": "pyright"}, indent=2
        )
    except Exception as e:
        return json.dumps({"error": str(e), "backend": "pyright"}, indent=2)


@mcp.tool()
def update_document(file: str, content: str) -> str:
    """Update file content for incremental analysis without writing to disk.

    Useful for testing code changes before saving.
    Uses Pyright backend for incremental updates.

    Args:
        file: Absolute path to the Python file
        content: New file content

    Returns:
        JSON string with confirmation
    """
    # Guard: check workspace
    error = validate_file_workspace(file)
    if error:
        return json.dumps(error, indent=2)

    try:
        workspace = _find_workspace(file)
        client = get_lsp_client(workspace)
        client.update_document(file, content)
        return json.dumps(
            {"success": True, "file": file, "backend": "pyright"}, indent=2
        )
    except Exception as e:
        return json.dumps({"error": str(e), "backend": "pyright"}, indent=2)



@mcp.tool()
def search(
    pattern: str,
    path: Optional[str] = None,
    glob: Optional[str] = None,
    case_sensitive: bool = True,
    max_results: int = 50,
) -> str:
    """Search for a regex pattern in files using ripgrep.

    Args:
        pattern: The regex pattern to search for
        path: Directory or file to search in (defaults to current working directory)
        glob: Glob pattern to filter files (e.g., "*.py", "**/*.ts")
        case_sensitive: Whether the search is case sensitive
        max_results: Maximum number of results to return

    Returns:
        JSON string with search results or error message
    """
    # Guard: check workspace if path is provided
    if path:
        error = validate_file_workspace(path)
        if error:
            return json.dumps(error, indent=2)

    result = get_search(
        pattern=pattern,
        path=path,
        glob=glob,
        case_sensitive=case_sensitive,
        max_results=max_results,
    )
    result["backend"] = "ripgrep"
    return json.dumps(result, indent=2)


@mcp.tool()
def set_backend(
    backend: Literal["rope", "pyright"],
    tool: Optional[str] = None,
) -> str:
    """Set the backend for code analysis tools.

    Args:
        backend: The backend to use ('rope' or 'pyright')
        tool: Optional tool name (hover/definition/references/completions/symbols).
              If not provided, sets the default backend for all shared tools.

    Returns:
        JSON string with the updated configuration
    """
    config = get_config()

    try:
        backend_enum = Backend(backend.lower())
    except ValueError:
        return json.dumps(
            {
                "error": f"Invalid backend: {backend}. Must be 'rope' or 'pyright'.",
            },
            indent=2,
        )

    if tool:
        if tool not in SHARED_TOOLS:
            return json.dumps(
                {
                    "error": f"Invalid tool: {tool}. Must be one of: {', '.join(SHARED_TOOLS)}",
                },
                indent=2,
            )
        config.set_backend(backend_enum, tool)
        return json.dumps(
            {
                "success": True,
                "message": f"Backend for '{tool}' set to '{backend}'",
                "tool": tool,
                "backend": backend,
            },
            indent=2,
        )
    else:
        config.set_all_backends(backend_enum)
        return json.dumps(
            {
                "success": True,
                "message": f"Default backend set to '{backend}' for all shared tools",
                "backend": backend,
                "affected_tools": list(SHARED_TOOLS),
            },
            indent=2,
        )


@mcp.tool()
def set_python_path(
    python_path: str,
    workspace: Optional[str] = None,
) -> str:
    """Set the Python interpreter path for code analysis.

    This affects how Rope resolves imports and analyzes code.
    The path is auto-detected from Pyright config or virtual environments,
    but can be manually overridden using this tool.

    Args:
        python_path: Absolute path to the Python interpreter
        workspace: Optional workspace to set the path for.
                   If not provided, sets the global default.

    Returns:
        JSON string with success status
    """
    result = config_set_python_path(python_path, workspace)
    return json.dumps(result, indent=2)


@mcp.tool()
def status() -> str:
    """Get the status of the MCP server.

    Returns:
        JSON string with server status information
    """
    rope_client = get_rope_client()
    rope_status = rope_client.get_status()

    config = get_config()
    python_status = get_python_path_status()

    # Get Python paths for active projects
    active_projects = rope_status.get("active_projects", [])
    project_python_paths = {}
    for project in active_projects:
        project_python_paths[project] = rope_client.get_python_path(project)

    status_info = {
        "server": "python-lsp-mcp",
        "version": __version__,
        "backends": {
            "rope": {
                "available": True,
                "description": "Fast, Python-native code analysis",
                "active_projects": active_projects,
                "project_python_paths": project_python_paths,
                "caching_enabled": rope_status.get("caching_enabled", False),
                "cache_folder": rope_status.get("cache_folder"),
            },
            "pyright": {
                "available": True,
                "description": "Full-featured type checking via LSP",
            },
            "ripgrep": {
                "available": True,
                "description": "Fast regex search",
            },
        },
        "config": {
            "default_backend": config.default_backend.value,
            "shared_tools": list(SHARED_TOOLS),
            "tool_backends": {
                tool: config.get_backend_for(tool).value for tool in SHARED_TOOLS
            },
            "rope_only_tools": ["rename"],
            "pyright_only_tools": ["diagnostics", "signature_help"],
        },
        "python_interpreter": {
            "current": python_status["current_interpreter"],
            "global_override": python_status["global_python_path"],
            "workspace_overrides": python_status["workspace_python_paths"],
        },
    }
    return json.dumps(status_info, indent=2)


@mcp.tool()
def reload_modules() -> str:
    """Reload all tool modules (development only).

    This reloads the Python modules so code changes take effect without
    restarting the server. Use this during development/debugging.

    Returns:
        JSON string with reload status
    """
    import importlib
    from . import tools
    from .tools import (
        hover,
        definition,
        references,
        completions,
        symbols,
        rename,
        move,
        change_signature,
        diagnostics,
        search,
    )
    from . import rope_client
    from . import config
    from .lsp import client as lsp_client

    reloaded = []
    errors = []

    # Reload in dependency order
    modules_to_reload = [
        ("config", config),
        ("rope_client", rope_client),
        ("lsp.client", lsp_client),
        ("tools.hover", hover),
        ("tools.definition", definition),
        ("tools.references", references),
        ("tools.completions", completions),
        ("tools.symbols", symbols),
        ("tools.rename", rename),
        ("tools.move", move),
        ("tools.change_signature", change_signature),
        ("tools.diagnostics", diagnostics),
        ("tools.search", search),
        ("tools", tools),
    ]

    for name, module in modules_to_reload:
        try:
            importlib.reload(module)
            reloaded.append(name)
        except Exception as e:
            errors.append({"module": name, "error": str(e)})

    # Re-import the functions we use
    global do_rename, do_move, do_change_signature, get_function_signature
    global rope_completions, rope_definition, rope_hover, rope_references, rope_symbols
    global get_diagnostics, get_search

    from .tools import (
        do_rename,
        do_move,
        do_change_signature,
        get_function_signature,
        get_completions as rope_completions,
        get_definition as rope_definition,
        get_hover as rope_hover,
        get_references as rope_references,
        get_symbols as rope_symbols,
        get_diagnostics,
        get_search,
    )

    return json.dumps(
        {
            "success": len(errors) == 0,
            "reloaded": reloaded,
            "errors": errors if errors else None,
        },
        indent=2,
    )


def _do_reload():
    """Perform module reload."""
    import importlib
    from . import tools
    from .tools import (
        hover,
        definition,
        references,
        completions,
        symbols,
        rename,
        move,
        change_signature,
        diagnostics,
        search,
    )
    from . import rope_client
    from . import config
    from .lsp import client as lsp_client

    # Reload in dependency order
    modules = [
        config,
        rope_client,
        lsp_client,
        hover,
        definition,
        references,
        completions,
        symbols,
        rename,
        move,
        change_signature,
        diagnostics,
        search,
        tools,
    ]

    for module in modules:
        try:
            importlib.reload(module)
        except Exception as e:
            print(f"Error reloading {module.__name__}: {e}", file=sys.stderr)

    # Re-import the functions
    global do_rename, do_move, do_change_signature, get_function_signature
    global rope_completions, rope_definition, rope_hover, rope_references, rope_symbols
    global get_diagnostics, get_search

    from .tools import (
        do_rename,
        do_move,
        do_change_signature,
        get_function_signature,
        get_completions as rope_completions,
        get_definition as rope_definition,
        get_hover as rope_hover,
        get_references as rope_references,
        get_symbols as rope_symbols,
        get_diagnostics,
        get_search,
    )

    print("Modules reloaded", file=sys.stderr)


def _start_file_watcher(src_path: str):
    """Start watching for file changes and reload modules."""
    try:
        from watchdog.observers import Observer
        from watchdog.events import FileSystemEventHandler, FileModifiedEvent
    except ImportError:
        print(
            "watchdog not installed. Run: uv pip install watchdog",
            file=sys.stderr,
        )
        return None

    class ReloadHandler(FileSystemEventHandler):
        def __init__(self):
            self._debounce_timer = None
            self._lock = threading.Lock()

        def _schedule_reload(self):
            with self._lock:
                if self._debounce_timer:
                    self._debounce_timer.cancel()
                self._debounce_timer = threading.Timer(0.5, self._do_reload)
                self._debounce_timer.start()

        def _do_reload(self):
            try:
                _do_reload()
            except Exception as e:
                print(f"Reload error: {e}", file=sys.stderr)

        def on_modified(self, event):
            if isinstance(event, FileModifiedEvent) and event.src_path.endswith(".py"):
                print(f"File changed: {event.src_path}", file=sys.stderr)
                self._schedule_reload()

    observer = Observer()
    observer.schedule(ReloadHandler(), src_path, recursive=True)
    observer.start()
    print(f"Watching for changes in: {src_path}", file=sys.stderr)
    return observer


def main():
    """Run the MCP server."""
    reload_mode = "--reload" in sys.argv or os.environ.get("MCP_RELOAD") == "1"

    observer = None
    if reload_mode:
        # Get the source path
        src_path = os.path.dirname(os.path.abspath(__file__))
        observer = _start_file_watcher(src_path)

    try:
        mcp.run()
    finally:
        if observer:
            observer.stop()
            observer.join()


if __name__ == "__main__":
    main()
