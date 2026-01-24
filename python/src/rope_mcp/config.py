"""Configuration for Python LSP MCP Server."""

import json
import sys
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional
import os

try:
    import tomllib  # type: ignore[import-not-found]
except ImportError:
    import tomli as tomllib  # type: ignore[import-not-found,import-untyped]


class Backend(Enum):
    """Available backends for code analysis."""

    ROPE = "rope"
    PYRIGHT = "pyright"


# Tools that support both backends
SHARED_TOOLS = {"hover", "definition", "references", "completions", "symbols"}

# Tools exclusive to each backend
ROPE_ONLY_TOOLS = {"rename"}  # Rope has better refactoring
PYRIGHT_ONLY_TOOLS = {"diagnostics", "signature_help"}  # Pyright exclusive

# Environment variable prefix (supports both old and new names)
ENV_PREFIXES = ["PYTHON_LSP_MCP_", "ROPE_MCP_"]


@dataclass
class ServerConfig:
    """Configuration for the MCP server."""

    # Default backend for shared features
    default_backend: Backend = Backend.ROPE

    # Per-tool backend overrides (None = use default)
    tool_backends: dict[str, Backend] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "ServerConfig":
        """Create config from environment variables.

        Environment variables (PYTHON_LSP_MCP_ or ROPE_MCP_ prefix):
            *_BACKEND: Default backend (rope/pyright), default: rope
            *_HOVER_BACKEND: Backend for hover (rope/pyright)
            *_DEFINITION_BACKEND: Backend for definition
            *_REFERENCES_BACKEND: Backend for references
            *_COMPLETIONS_BACKEND: Backend for completions
            *_SYMBOLS_BACKEND: Backend for symbols
        """

        def get_env(suffix: str) -> Optional[str]:
            """Get environment variable with any prefix."""
            for prefix in ENV_PREFIXES:
                val = os.environ.get(f"{prefix}{suffix}", "").lower()
                if val:
                    return val
            return None

        default = get_env("BACKEND") or "rope"
        default_backend = (
            Backend(default) if default in ["rope", "pyright"] else Backend.ROPE
        )

        tool_backends = {}
        for tool in SHARED_TOOLS:
            val = get_env(f"{tool.upper()}_BACKEND")
            if val in ["rope", "pyright"]:
                tool_backends[tool] = Backend(val)

        return cls(
            default_backend=default_backend,
            tool_backends=tool_backends,
        )

    def get_backend_for(self, tool: str) -> Backend:
        """Get the backend to use for a specific tool."""
        if tool in ROPE_ONLY_TOOLS:
            return Backend.ROPE
        if tool in PYRIGHT_ONLY_TOOLS:
            return Backend.PYRIGHT

        if tool in self.tool_backends:
            return self.tool_backends[tool]
        return self.default_backend

    def set_backend(self, backend: Backend, tool: Optional[str] = None) -> None:
        """Set the backend for a tool or as default.

        Args:
            backend: The backend to use
            tool: Optional tool name. If None, sets the default backend.
        """
        if tool is None:
            self.default_backend = backend
        elif tool in SHARED_TOOLS:
            self.tool_backends[tool] = backend

    def set_all_backends(self, backend: Backend) -> None:
        """Set all shared tools to use the same backend."""
        self.default_backend = backend
        self.tool_backends.clear()


# Global config instance
_config: Optional[ServerConfig] = None


def get_config() -> ServerConfig:
    """Get the global server configuration."""
    global _config
    if _config is None:
        _config = ServerConfig.from_env()
    return _config


def set_config(config: ServerConfig) -> None:
    """Set the global server configuration."""
    global _config
    _config = config


# ============================================================================
# Python Interpreter Path Configuration
# ============================================================================


def find_pyright_python_path(workspace: str) -> Optional[str]:
    """Find Python path from Pyright configuration.

    Checks in order:
    1. pyrightconfig.json
    2. pyproject.toml [tool.pyright]

    Args:
        workspace: The workspace root directory

    Returns:
        Python interpreter path if found, None otherwise
    """
    workspace_path = Path(workspace)

    # Check pyrightconfig.json
    pyright_config = workspace_path / "pyrightconfig.json"
    if pyright_config.exists():
        try:
            with open(pyright_config, "r", encoding="utf-8") as f:
                config = json.load(f)
            python_path = _extract_python_path_from_pyright(config, workspace_path)
            if python_path:
                return python_path
        except (json.JSONDecodeError, OSError):
            pass

    # Check pyproject.toml
    pyproject = workspace_path / "pyproject.toml"
    if pyproject.exists():
        try:
            with open(pyproject, "rb") as f:
                config = tomllib.load(f)
            pyright_config = config.get("tool", {}).get("pyright", {})
            python_path = _extract_python_path_from_pyright(
                pyright_config, workspace_path
            )
            if python_path:
                return python_path
        except (tomllib.TOMLDecodeError, OSError):
            pass

    return None


def _extract_python_path_from_pyright(
    config: dict, workspace_path: Path
) -> Optional[str]:
    """Extract Python path from Pyright config dict.

    Supports:
    - pythonPath: direct path to Python interpreter
    - venvPath + venv: virtual environment path
    """
    # Direct pythonPath
    if "pythonPath" in config:
        python_path = Path(config["pythonPath"])
        if not python_path.is_absolute():
            python_path = workspace_path / python_path
        if python_path.exists():
            return str(python_path)

    # venvPath + venv combination
    venv_path = config.get("venvPath")
    venv_name = config.get("venv")
    if venv_path and venv_name:
        venv_dir = Path(venv_path)
        if not venv_dir.is_absolute():
            venv_dir = workspace_path / venv_dir
        venv_dir = venv_dir / venv_name

        # Check for Python executable
        if sys.platform == "win32":
            python_exe = venv_dir / "Scripts" / "python.exe"
        else:
            python_exe = venv_dir / "bin" / "python"

        if python_exe.exists():
            return str(python_exe)

    return None


def find_venv_python_path(workspace: str) -> Optional[str]:
    """Find Python path from common virtual environment locations.

    Checks:
    - .venv/bin/python
    - venv/bin/python
    - env/bin/python

    Args:
        workspace: The workspace root directory

    Returns:
        Python interpreter path if found, None otherwise
    """
    workspace_path = Path(workspace)
    venv_dirs = [".venv", "venv", "env"]

    for venv_dir in venv_dirs:
        if sys.platform == "win32":
            python_exe = workspace_path / venv_dir / "Scripts" / "python.exe"
        else:
            python_exe = workspace_path / venv_dir / "bin" / "python"

        if python_exe.exists():
            return str(python_exe)

    return None


def get_python_path_for_workspace(workspace: str) -> str:
    """Get the Python interpreter path for a workspace.

    Priority:
    1. Manually set path (via set_python_path tool)
    2. Pyright configuration (pyrightconfig.json or pyproject.toml)
    3. Virtual environment in workspace (.venv, venv, env)
    4. Current Python interpreter (sys.executable)

    Args:
        workspace: The workspace root directory

    Returns:
        Path to Python interpreter
    """
    workspace = os.path.abspath(workspace)

    # Check manually set path
    if workspace in _python_paths:
        return _python_paths[workspace]

    # Check global override
    if _global_python_path:
        return _global_python_path

    # Check Pyright config
    pyright_path = find_pyright_python_path(workspace)
    if pyright_path:
        return pyright_path

    # Check virtual environment
    venv_path = find_venv_python_path(workspace)
    if venv_path:
        return venv_path

    # Fall back to current interpreter
    return sys.executable


# Per-workspace Python paths (set via tool)
_python_paths: dict[str, str] = {}

# Global Python path override
_global_python_path: Optional[str] = None


def set_python_path(python_path: str, workspace: Optional[str] = None) -> dict:
    """Set the Python interpreter path.

    Args:
        python_path: Path to Python interpreter
        workspace: Optional workspace to set path for.
                   If None, sets global default.

    Returns:
        Dict with success status and message
    """
    global _global_python_path

    # Validate the path exists
    path = Path(python_path)
    if not path.exists():
        return {
            "success": False,
            "error": f"Python path does not exist: {python_path}",
        }

    # Check if it's executable
    if not os.access(python_path, os.X_OK):
        return {
            "success": False,
            "error": f"Python path is not executable: {python_path}",
        }

    if workspace:
        workspace = os.path.abspath(workspace)
        _python_paths[workspace] = python_path
        return {
            "success": True,
            "message": f"Python path set for workspace: {workspace}",
            "python_path": python_path,
            "workspace": workspace,
        }
    else:
        _global_python_path = python_path
        return {
            "success": True,
            "message": "Global Python path set",
            "python_path": python_path,
        }


def get_python_path_status() -> dict:
    """Get the current Python path configuration status."""
    return {
        "global_python_path": _global_python_path,
        "workspace_python_paths": dict(_python_paths),
        "current_interpreter": sys.executable,
    }
