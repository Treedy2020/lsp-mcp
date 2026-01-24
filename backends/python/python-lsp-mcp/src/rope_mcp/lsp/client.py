"""LSP client for connecting to Pyright language server."""

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Optional

from .types import DocumentState


class LspClient:
    """Client for communicating with Pyright language server via JSON-RPC."""

    def __init__(self, workspace_root: str):
        self.workspace_root = os.path.abspath(workspace_root)
        self._process: Optional[subprocess.Popen] = None
        self._request_id = 0
        self._lock = threading.Lock()
        self._pending_requests: dict[int, threading.Event] = {}
        self._responses: dict[int, Any] = {}
        self._documents: dict[str, DocumentState] = {}
        self._initialized = False
        self._reader_thread: Optional[threading.Thread] = None
        self._running = False

    def _start_server(self) -> None:
        """Start the Pyright language server process."""
        if self._process is not None:
            return

        # Try to find pyright-langserver
        # Use DEVNULL for stderr to prevent buffer blocking (like TS version)
        try:
            self._process = subprocess.Popen(
                ["pyright-langserver", "--stdio"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                cwd=self.workspace_root,
            )
        except FileNotFoundError:
            # Try npx
            self._process = subprocess.Popen(
                ["npx", "pyright-langserver", "--stdio"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                cwd=self.workspace_root,
            )

        self._running = True
        self._reader_thread = threading.Thread(target=self._read_responses, daemon=True)
        self._reader_thread.start()

    def _read_responses(self) -> None:
        """Background thread to read responses from the server."""
        while self._running and self._process and self._process.stdout:
            stdout = self._process.stdout
            try:
                # Read Content-Length header
                header = b""
                while not header.endswith(b"\r\n\r\n"):
                    char = stdout.read(1)
                    if not char:
                        return
                    header += char

                # Parse Content-Length
                content_length = 0
                for line in header.decode().split("\r\n"):
                    if line.startswith("Content-Length:"):
                        content_length = int(line.split(":")[1].strip())
                        break

                if content_length == 0:
                    continue

                # Read content
                content = stdout.read(content_length)
                message = json.loads(content.decode())

                # Handle response
                if "id" in message and message["id"] in self._pending_requests:
                    req_id = message["id"]
                    self._responses[req_id] = message
                    self._pending_requests[req_id].set()

            except Exception:
                if self._running:
                    continue
                break

    def _send_message(self, message: dict) -> None:
        """Send a JSON-RPC message to the server."""
        if not self._process or not self._process.stdin:
            raise RuntimeError("Server not started")

        content = json.dumps(message)
        header = f"Content-Length: {len(content)}\r\n\r\n"
        self._process.stdin.write(header.encode() + content.encode())
        self._process.stdin.flush()

    def _send_request(
        self, method: str, params: Any = None, timeout: float = 30.0
    ) -> Any:
        """Send a request and wait for response."""
        with self._lock:
            self._request_id += 1
            req_id = self._request_id

        message = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            message["params"] = params

        event = threading.Event()
        self._pending_requests[req_id] = event

        self._send_message(message)

        if not event.wait(timeout):
            del self._pending_requests[req_id]
            raise TimeoutError(f"Request {method} timed out")

        del self._pending_requests[req_id]
        response = self._responses.pop(req_id)

        if "error" in response:
            raise RuntimeError(f"LSP error: {response['error']}")

        return response.get("result")

    def _send_notification(self, method: str, params: Any = None) -> None:
        """Send a notification (no response expected)."""
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._send_message(message)

    def initialize(self) -> None:
        """Initialize the LSP connection."""
        if self._initialized:
            return

        self._start_server()

        # Send initialize request
        # Note: Do NOT declare workspace.workspaceFolders capability
        # pyright-langserver will send workspace/workspaceFolders requests
        # that we don't handle, causing requests to hang
        init_params = {
            "processId": os.getpid(),
            "rootUri": self._path_to_uri(self.workspace_root),
            "capabilities": {
                "textDocument": {
                    "hover": {"contentFormat": ["markdown", "plaintext"]},
                    "completion": {
                        "completionItem": {
                            "snippetSupport": True,
                            "documentationFormat": ["markdown", "plaintext"],
                        },
                    },
                    "signatureHelp": {
                        "signatureInformation": {
                            "documentationFormat": ["markdown", "plaintext"],
                        },
                    },
                    "definition": {"linkSupport": True},
                    "references": {},
                    "rename": {"prepareSupport": True},
                    "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                    "publishDiagnostics": {},
                },
                # Note: Do NOT include workspace.workspaceFolders here
            },
            "workspaceFolders": [
                {
                    "uri": self._path_to_uri(self.workspace_root),
                    "name": Path(self.workspace_root).name,
                }
            ],
        }

        self._send_request("initialize", init_params)
        self._send_notification("initialized", {})
        self._initialized = True

    def shutdown(self) -> None:
        """Shutdown the LSP connection."""
        if not self._initialized:
            return

        self._running = False

        try:
            self._send_request("shutdown", timeout=5.0)
            self._send_notification("exit")
        except Exception:
            pass

        if self._process:
            self._process.terminate()
            self._process.wait(timeout=5)
            self._process = None

        self._initialized = False

    def _path_to_uri(self, path: str) -> str:
        """Convert file path to URI."""
        abs_path = os.path.abspath(path)
        if sys.platform == "win32":
            return f"file:///{abs_path.replace(os.sep, '/')}"
        return f"file://{abs_path}"

    def _uri_to_path(self, uri: str) -> str:
        """Convert URI to file path."""
        if uri.startswith("file://"):
            path = uri[7:]
            if sys.platform == "win32" and path.startswith("/"):
                path = path[1:]
            return path
        return uri

    def open_document(self, file_path: str) -> None:
        """Open a document in the language server."""
        self.initialize()

        uri = self._path_to_uri(file_path)
        if uri in self._documents:
            return

        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        self._documents[uri] = DocumentState(
            uri=uri,
            version=1,
            content=content,
        )

        self._send_notification(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": uri,
                    "languageId": "python",
                    "version": 1,
                    "text": content,
                }
            },
        )

    def update_document(self, file_path: str, content: str) -> None:
        """Update document content (incremental)."""
        self.initialize()

        uri = self._path_to_uri(file_path)
        if uri not in self._documents:
            self.open_document(file_path)
            # Now update with new content
            uri = self._path_to_uri(file_path)

        doc = self._documents[uri]
        doc.version += 1
        doc.content = content

        self._send_notification(
            "textDocument/didChange",
            {
                "textDocument": {"uri": uri, "version": doc.version},
                "contentChanges": [{"text": content}],
            },
        )

    def close_document(self, file_path: str) -> None:
        """Close a document."""
        uri = self._path_to_uri(file_path)
        if uri not in self._documents:
            return

        self._send_notification(
            "textDocument/didClose",
            {"textDocument": {"uri": uri}},
        )
        del self._documents[uri]

    def refresh_document(self, file_path: str) -> None:
        """Refresh a document after external modification.

        If the document is already open, sends didChange with new content.
        Otherwise, opens it fresh when needed later.
        """
        if not os.path.exists(file_path):
            # File was deleted, close if open
            uri = self._path_to_uri(file_path)
            if uri in self._documents:
                self.close_document(file_path)
            return

        uri = self._path_to_uri(file_path)
        if uri in self._documents:
            # Document is open - read new content and send didChange
            with open(file_path, "r", encoding="utf-8") as f:
                new_content = f.read()
            self.update_document(file_path, new_content)
        # If not open, it will be opened fresh when needed

    def refresh_documents(self, file_paths: list[str]) -> None:
        """Refresh multiple documents after external modification."""
        for file_path in file_paths:
            self.refresh_document(file_path)

    def hover(self, file_path: str, line: int, column: int) -> Optional[dict]:
        """Get hover information at position."""
        self.open_document(file_path)
        uri = self._path_to_uri(file_path)

        result = self._send_request(
            "textDocument/hover",
            {
                "textDocument": {"uri": uri},
                "position": {"line": line - 1, "character": column - 1},
            },
        )

        if not result:
            return None

        contents = result.get("contents", {})
        if isinstance(contents, dict):
            return {"contents": contents.get("value", "")}
        elif isinstance(contents, str):
            return {"contents": contents}
        elif isinstance(contents, list):
            return {
                "contents": "\n".join(
                    c.get("value", c) if isinstance(c, dict) else c for c in contents
                )
            }
        return None

    def definition(self, file_path: str, line: int, column: int) -> list[dict]:
        """Get definition locations."""
        self.open_document(file_path)
        uri = self._path_to_uri(file_path)

        result = self._send_request(
            "textDocument/definition",
            {
                "textDocument": {"uri": uri},
                "position": {"line": line - 1, "character": column - 1},
            },
        )

        if not result:
            return []

        if isinstance(result, dict):
            result = [result]

        locations = []
        for loc in result:
            locations.append(
                {
                    "file": self._uri_to_path(loc["uri"]),
                    "line": loc["range"]["start"]["line"] + 1,
                    "column": loc["range"]["start"]["character"] + 1,
                }
            )
        return locations

    def references(
        self, file_path: str, line: int, column: int, include_declaration: bool = True
    ) -> list[dict]:
        """Find all references."""
        self.open_document(file_path)
        uri = self._path_to_uri(file_path)

        result = self._send_request(
            "textDocument/references",
            {
                "textDocument": {"uri": uri},
                "position": {"line": line - 1, "character": column - 1},
                "context": {"includeDeclaration": include_declaration},
            },
        )

        if not result:
            return []

        references = []
        for loc in result:
            references.append(
                {
                    "file": self._uri_to_path(loc["uri"]),
                    "line": loc["range"]["start"]["line"] + 1,
                    "column": loc["range"]["start"]["character"] + 1,
                }
            )
        return references

    def completions(self, file_path: str, line: int, column: int) -> list[dict]:
        """Get completion items."""
        self.open_document(file_path)
        uri = self._path_to_uri(file_path)

        result = self._send_request(
            "textDocument/completion",
            {
                "textDocument": {"uri": uri},
                "position": {"line": line - 1, "character": column - 1},
            },
        )

        if not result:
            return []

        items = result if isinstance(result, list) else result.get("items", [])

        completions = []
        for item in items:
            completions.append(
                {
                    "label": item.get("label", ""),
                    "kind": self._completion_kind_to_string(item.get("kind", 1)),
                    "detail": item.get("detail", ""),
                    "documentation": self._get_documentation(item.get("documentation")),
                }
            )
        return completions

    def document_symbols(self, file_path: str) -> list[dict]:
        """Get document symbols."""
        self.open_document(file_path)
        uri = self._path_to_uri(file_path)

        result = self._send_request(
            "textDocument/documentSymbol",
            {"textDocument": {"uri": uri}},
        )

        if not result:
            return []

        return self._flatten_symbols(result, file_path)

    def signature_help(self, file_path: str, line: int, column: int) -> Optional[dict]:
        """Get signature help."""
        self.open_document(file_path)
        uri = self._path_to_uri(file_path)

        result = self._send_request(
            "textDocument/signatureHelp",
            {
                "textDocument": {"uri": uri},
                "position": {"line": line - 1, "character": column - 1},
            },
        )

        if not result or not result.get("signatures"):
            return None

        signatures = result.get("signatures", [])
        active_signature = result.get("activeSignature", 0)

        if not signatures:
            return None

        sig = (
            signatures[active_signature]
            if active_signature < len(signatures)
            else signatures[0]
        )
        return {
            "label": sig.get("label", ""),
            "documentation": self._get_documentation(sig.get("documentation")),
            "parameters": [
                {
                    "label": p.get("label", ""),
                    "documentation": self._get_documentation(p.get("documentation")),
                }
                for p in sig.get("parameters", [])
            ],
            "active_parameter": result.get("activeParameter", 0),
        }

    def _flatten_symbols(
        self, symbols: list, file_path: str, parent: str = ""
    ) -> list[dict]:
        """Flatten hierarchical symbols."""
        result = []
        for sym in symbols:
            name = sym.get("name", "")
            full_name = f"{parent}.{name}" if parent else name
            result.append(
                {
                    "name": name,
                    "kind": self._symbol_kind_to_string(sym.get("kind", 1)),
                    "line": sym.get("range", {}).get("start", {}).get("line", 0) + 1,
                    "column": sym.get("range", {}).get("start", {}).get("character", 0)
                    + 1,
                    "file": file_path,
                }
            )
            # Recurse into children
            if "children" in sym:
                result.extend(
                    self._flatten_symbols(sym["children"], file_path, full_name)
                )
        return result

    def _get_documentation(self, doc: Any) -> str:
        """Extract documentation string."""
        if not doc:
            return ""
        if isinstance(doc, str):
            return doc
        if isinstance(doc, dict):
            return doc.get("value", "")
        return ""

    def _completion_kind_to_string(self, kind: int) -> str:
        """Convert LSP CompletionItemKind to string."""
        kinds = {
            1: "Text",
            2: "Method",
            3: "Function",
            4: "Constructor",
            5: "Field",
            6: "Variable",
            7: "Class",
            8: "Interface",
            9: "Module",
            10: "Property",
            11: "Unit",
            12: "Value",
            13: "Enum",
            14: "Keyword",
            15: "Snippet",
            16: "Color",
            17: "File",
            18: "Reference",
            19: "Folder",
            20: "EnumMember",
            21: "Constant",
            22: "Struct",
            23: "Event",
            24: "Operator",
            25: "TypeParameter",
        }
        return kinds.get(kind, "Text")

    def _symbol_kind_to_string(self, kind: int) -> str:
        """Convert LSP SymbolKind to string."""
        kinds = {
            1: "File",
            2: "Module",
            3: "Namespace",
            4: "Package",
            5: "Class",
            6: "Method",
            7: "Property",
            8: "Field",
            9: "Constructor",
            10: "Enum",
            11: "Interface",
            12: "Function",
            13: "Variable",
            14: "Constant",
            15: "String",
            16: "Number",
            17: "Boolean",
            18: "Array",
            19: "Object",
            20: "Key",
            21: "Null",
            22: "EnumMember",
            23: "Struct",
            24: "Event",
            25: "Operator",
            26: "TypeParameter",
        }
        return kinds.get(kind, "Variable")


# Global client instances per workspace
_clients: dict[str, LspClient] = {}
_lock = threading.Lock()


def get_lsp_client(workspace_root: str) -> LspClient:
    """Get or create an LSP client for the workspace."""
    workspace_root = os.path.abspath(workspace_root)
    with _lock:
        if workspace_root not in _clients:
            _clients[workspace_root] = LspClient(workspace_root)
        return _clients[workspace_root]


def close_all_clients() -> None:
    """Close all LSP clients."""
    with _lock:
        for client in _clients.values():
            try:
                client.shutdown()
            except Exception:
                pass
        _clients.clear()


def refresh_lsp_documents(file_paths: list[str]) -> None:
    """Refresh documents in all LSP clients after external modification.

    This should be called after Rope refactoring operations that modify
    files on disk, so that Pyright picks up the changes.
    """
    with _lock:
        for client in _clients.values():
            try:
                client.refresh_documents(file_paths)
            except Exception:
                pass
