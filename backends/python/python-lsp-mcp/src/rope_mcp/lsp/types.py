"""LSP protocol types."""

from dataclasses import dataclass


@dataclass
class Position:
    """Position in a text document (0-based)."""

    line: int
    character: int

    def to_dict(self) -> dict:
        return {"line": self.line, "character": self.character}

    @classmethod
    def from_dict(cls, d: dict) -> "Position":
        return cls(line=d["line"], character=d["character"])


@dataclass
class Range:
    """Range in a text document."""

    start: Position
    end: Position

    def to_dict(self) -> dict:
        return {"start": self.start.to_dict(), "end": self.end.to_dict()}

    @classmethod
    def from_dict(cls, d: dict) -> "Range":
        return cls(
            start=Position.from_dict(d["start"]),
            end=Position.from_dict(d["end"]),
        )


@dataclass
class Location:
    """Location in a document."""

    uri: str
    range: Range

    @classmethod
    def from_dict(cls, d: dict) -> "Location":
        return cls(uri=d["uri"], range=Range.from_dict(d["range"]))


@dataclass
class TextDocumentIdentifier:
    """Identifies a text document."""

    uri: str

    def to_dict(self) -> dict:
        return {"uri": self.uri}


@dataclass
class TextDocumentPositionParams:
    """Parameters for text document position requests."""

    text_document: TextDocumentIdentifier
    position: Position

    def to_dict(self) -> dict:
        return {
            "textDocument": self.text_document.to_dict(),
            "position": self.position.to_dict(),
        }


@dataclass
class DocumentState:
    """State of an open document."""

    uri: str
    version: int
    content: str
    language_id: str = "python"
