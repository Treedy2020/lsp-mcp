"""Search tool implementation using ripgrep."""

import json
import os
import subprocess
from typing import Optional


def get_search(
    pattern: str,
    path: Optional[str] = None,
    glob: Optional[str] = None,
    case_sensitive: bool = True,
    max_results: int = 50,
) -> dict:
    """Search for a regex pattern in files using ripgrep.

    Args:
        pattern: The regex pattern to search for
        path: Directory or file to search in (defaults to current working directory)
        glob: Glob pattern to filter files (e.g., "*.py", "**/*.ts")
        case_sensitive: Whether the search is case sensitive
        max_results: Maximum number of results to return

    Returns:
        Dict containing search results or error message
    """
    search_path = path or os.getcwd()

    # Build rg command
    rg_args = [
        "rg",
        "--json",
        "--line-number",
        "--column",
    ]

    if not case_sensitive:
        rg_args.append("--ignore-case")

    if glob:
        rg_args.extend(["--glob", glob])

    rg_args.extend(["--", pattern, search_path])

    try:
        result = subprocess.run(
            rg_args,
            capture_output=True,
            text=True,
            timeout=60,
        )

        # rg returns 1 when no matches found (not an error)
        if result.returncode == 1 and not result.stdout.strip():
            return {
                "results": [],
                "count": 0,
                "message": f"No matches found for pattern: {pattern}",
            }

        # rg returns 2 when there are errors but may still have results
        # We should still try to parse any results we got
        if result.returncode not in (0, 1, 2) or (
            result.returncode != 0 and not result.stdout.strip()
        ):
            return {
                "error": f"ripgrep error: {result.stderr}",
                "pattern": pattern,
            }

        results = []
        lines = result.stdout.strip().split("\n") if result.stdout.strip() else []

        for line in lines:
            if not line:
                continue
            if len(results) >= max_results:
                break

            try:
                data = json.loads(line)
                if data.get("type") == "match":
                    match_data = data["data"]
                    file_path = match_data["path"]["text"]
                    line_number = match_data["line_number"]
                    line_text = match_data["lines"]["text"].rstrip()

                    # Get all submatches in this line
                    for submatch in match_data.get("submatches", []):
                        if len(results) >= max_results:
                            break
                        results.append(
                            {
                                "file": os.path.abspath(file_path),
                                "line": line_number,
                                "column": submatch["start"] + 1,  # Convert to 1-based
                                "text": line_text,
                                "match": submatch["match"]["text"],
                            }
                        )
            except (json.JSONDecodeError, KeyError):
                # Skip non-JSON or malformed lines
                continue

        return {
            "results": results,
            "count": len(results),
            "pattern": pattern,
            "path": search_path,
            "limited": len(results) >= max_results,
        }

    except FileNotFoundError:
        return {
            "error": "ripgrep (rg) is not installed. Install with: brew install ripgrep",
            "pattern": pattern,
        }
    except subprocess.TimeoutExpired:
        return {
            "error": "Search timed out",
            "pattern": pattern,
        }
    except Exception as e:
        return {
            "error": str(e),
            "pattern": pattern,
        }
