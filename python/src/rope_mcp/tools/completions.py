"""Completions tool implementation - code completion."""

from rope.contrib import codeassist

from ..rope_client import get_client


def get_completions(file: str, line: int, column: int) -> dict:
    """Get code completion suggestions at the given position.

    Args:
        file: Absolute path to the Python file
        line: 1-based line number
        column: 1-based column number

    Returns:
        Dict containing completion items or error message
    """
    client = get_client()

    try:
        workspace = client.find_workspace_for_file(file)
        project = client.get_project(workspace)
        resource = client.get_resource(project, file)
        source = resource.read()
        offset = client.position_to_offset(source, line, column)

        proposals = codeassist.code_assist(project, source, offset, resource)

        # Sort proposals by relevance
        proposals = codeassist.sorted_proposals(proposals)

        completions = []
        for proposal in proposals:
            # Use scope instead of deprecated kind property
            scope = getattr(proposal, "scope", None) or getattr(proposal, "kind", "")
            item = {
                "label": proposal.name,
                "kind": _get_completion_kind(scope),
                "detail": proposal.type or "",
            }

            # Add documentation if available
            if hasattr(proposal, "get_doc") and callable(proposal.get_doc):
                try:
                    doc = proposal.get_doc()
                    if doc:
                        item["documentation"] = doc
                except Exception:
                    pass

            completions.append(item)

        return {
            "completions": completions,
            "count": len(completions),
        }

    except Exception as e:
        return {
            "error": str(e),
            "file": file,
            "line": line,
            "column": column,
        }


def _get_completion_kind(rope_kind: str) -> str:
    """Map Rope completion kinds to standard kinds."""
    kind_map = {
        "function": "Function",
        "class": "Class",
        "module": "Module",
        "variable": "Variable",
        "attribute": "Property",
        "builtin": "Constant",
        "parameter": "Variable",
        "keyword": "Keyword",
        "imported": "Module",
        "instance": "Variable",
        "local": "Variable",
        "global": "Variable",
    }
    return kind_map.get(rope_kind, "Text")
