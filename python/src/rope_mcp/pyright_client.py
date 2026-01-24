"""Pyright client wrapper for running Pyright CLI commands."""

import json
import subprocess
from pathlib import Path
from typing import Optional


class PyrightClient:
    """Runs Pyright CLI for diagnostics and analysis."""

    def __init__(self):
        self._pyright_path: Optional[str] = None
        self._check_pyright()

    def _check_pyright(self) -> None:
        """Check if Pyright is available."""
        try:
            result = subprocess.run(
                ["pyright", "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                self._pyright_path = "pyright"
        except (FileNotFoundError, subprocess.TimeoutExpired):
            # Try npx
            try:
                result = subprocess.run(
                    ["npx", "pyright", "--version"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if result.returncode == 0:
                    self._pyright_path = "npx pyright"
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass

    @property
    def is_available(self) -> bool:
        """Check if Pyright is available."""
        return self._pyright_path is not None

    def get_version(self) -> Optional[str]:
        """Get Pyright version."""
        if not self.is_available or self._pyright_path is None:
            return None

        try:
            cmd = self._pyright_path.split() + ["--version"]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.stdout.strip()
        except Exception:
            return None

    def get_diagnostics(self, path: str) -> dict:
        """Get diagnostics for a file or directory.

        Args:
            path: Path to file or directory

        Returns:
            Dict containing diagnostics or error
        """
        if not self.is_available or self._pyright_path is None:
            return {
                "error": "Pyright is not installed. Install with: npm install -g pyright",
            }

        try:
            cmd = self._pyright_path.split() + ["--outputjson", path]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(Path(path).parent) if Path(path).is_file() else path,
            )

            # Parse JSON output
            try:
                data = json.loads(result.stdout)
            except json.JSONDecodeError:
                # Pyright might output non-JSON errors
                return {
                    "error": f"Failed to parse Pyright output: {result.stderr or result.stdout}",
                }

            # Format diagnostics
            diagnostics = []
            for diag in data.get("generalDiagnostics", []):
                diagnostics.append(
                    {
                        "file": diag.get("file", ""),
                        "line": diag.get("range", {}).get("start", {}).get("line", 0)
                        + 1,
                        "column": diag.get("range", {})
                        .get("start", {})
                        .get("character", 0)
                        + 1,
                        "end_line": diag.get("range", {}).get("end", {}).get("line", 0)
                        + 1,
                        "end_column": diag.get("range", {})
                        .get("end", {})
                        .get("character", 0)
                        + 1,
                        "severity": diag.get("severity", "error"),
                        "message": diag.get("message", ""),
                        "rule": diag.get("rule", ""),
                    }
                )

            summary = data.get("summary", {})
            return {
                "diagnostics": diagnostics,
                "summary": {
                    "files_analyzed": summary.get("filesAnalyzed", 0),
                    "errors": summary.get("errorCount", 0),
                    "warnings": summary.get("warningCount", 0),
                    "informations": summary.get("informationCount", 0),
                },
                "version": data.get("version", ""),
            }

        except subprocess.TimeoutExpired:
            return {"error": "Pyright analysis timed out"}
        except Exception as e:
            return {"error": str(e)}


# Global client instance
_client: Optional[PyrightClient] = None


def get_pyright_client() -> PyrightClient:
    """Get the global PyrightClient instance."""
    global _client
    if _client is None:
        _client = PyrightClient()
    return _client
