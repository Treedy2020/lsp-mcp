"""Rope client wrapper for managing projects and providing code analysis."""

import os
import subprocess
from pathlib import Path
from typing import Optional

import rope.base.project
from rope.base.resources import Resource

from .config import get_python_path_for_workspace


def _get_site_packages(python_executable: str) -> list[str]:
    """Get site-packages paths from a Python interpreter.

    Args:
        python_executable: Path to Python interpreter

    Returns:
        List of site-packages paths
    """
    try:
        result = subprocess.run(
            [python_executable, "-c", "import site; print('\\n'.join(site.getsitepackages()))"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            paths = [p.strip() for p in result.stdout.strip().split("\n") if p.strip()]
            return paths
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass
    return []


class RopeClient:
    """Manages Rope projects and provides code analysis operations."""

    def __init__(self):
        self._projects: dict[str, rope.base.project.Project] = {}
        self._project_python_paths: dict[str, str] = {}

    def get_project(self, workspace: str) -> rope.base.project.Project:
        """Get or create a Rope project for the given workspace."""
        workspace = os.path.abspath(workspace)

        # Get the Python interpreter path for this workspace
        python_executable = get_python_path_for_workspace(workspace)

        # Check if we need to recreate the project (Python path changed)
        if workspace in self._projects:
            if self._project_python_paths.get(workspace) != python_executable:
                # Python path changed, close old project
                self._projects[workspace].close()
                del self._projects[workspace]

        if workspace not in self._projects:
            project = rope.base.project.Project(
                workspace,
                ropefolder=None,  # Don't create .ropeproject folder
            )

            # Get site-packages from the Python interpreter and add to python_path
            site_packages = _get_site_packages(python_executable)
            if site_packages:
                project.prefs.set("python_path", site_packages)

            self._projects[workspace] = project
            self._project_python_paths[workspace] = python_executable

        return self._projects[workspace]

    def get_python_path(self, workspace: str) -> str:
        """Get the Python path being used for a workspace."""
        workspace = os.path.abspath(workspace)
        return self._project_python_paths.get(
            workspace, get_python_path_for_workspace(workspace)
        )

    def get_resource(
        self, project: rope.base.project.Project, file_path: str
    ) -> Resource:
        """Get a Rope resource for a file path."""
        abs_path = os.path.abspath(file_path)
        project_root = project.root.real_path

        if abs_path.startswith(project_root):
            rel_path = os.path.relpath(abs_path, project_root)
        else:
            rel_path = abs_path

        return project.get_resource(rel_path)

    def position_to_offset(self, source: str, line: int, column: int) -> int:
        """Convert (line, column) to byte offset.

        Args:
            source: The source code string
            line: 1-based line number
            column: 1-based column number

        Returns:
            0-based byte offset
        """
        lines = source.splitlines(keepends=True)
        offset = 0
        for i in range(min(line - 1, len(lines))):
            offset += len(lines[i])
        offset += column - 1
        return offset

    def offset_to_position(self, source: str, offset: int) -> tuple[int, int]:
        """Convert byte offset to (line, column).

        Args:
            source: The source code string
            offset: 0-based byte offset

        Returns:
            Tuple of (1-based line, 1-based column)
        """
        lines = source.splitlines(keepends=True)
        current_offset = 0
        for i, line_text in enumerate(lines):
            if current_offset + len(line_text) > offset:
                return (i + 1, offset - current_offset + 1)
            current_offset += len(line_text)
        # Offset is at the end
        return (len(lines), len(lines[-1]) + 1 if lines else 1)

    def find_workspace_for_file(self, file_path: str) -> str:
        """Find the workspace root for a given file.

        Looks for common project markers like pyproject.toml, setup.py, .git, etc.
        Falls back to the file's parent directory.
        """
        path = Path(file_path).resolve()
        markers = [
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            ".git",
            "requirements.txt",
        ]

        current = path.parent
        while current != current.parent:
            for marker in markers:
                if (current / marker).exists():
                    return str(current)
            current = current.parent

        return str(path.parent)

    def close_project(self, workspace: str) -> None:
        """Close and remove a project from the cache."""
        workspace = os.path.abspath(workspace)
        if workspace in self._projects:
            self._projects[workspace].close()
            del self._projects[workspace]

    def close_all(self) -> None:
        """Close all cached projects."""
        for project in self._projects.values():
            project.close()
        self._projects.clear()

    def get_status(self) -> dict:
        """Get status information about the Rope client."""
        return {
            "active_projects": list(self._projects.keys()),
            "project_count": len(self._projects),
        }


# Global client instance
_client: Optional[RopeClient] = None


def get_client() -> RopeClient:
    """Get the global RopeClient instance."""
    global _client
    if _client is None:
        _client = RopeClient()
    return _client
