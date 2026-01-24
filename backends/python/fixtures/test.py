"""Test Python file for Pyright MCP server."""

from typing import List, Optional


def greet(name: str, greeting: str = "Hello") -> str:
    """Return a greeting message.

    Args:
        name: The name to greet.
        greeting: The greeting word to use.

    Returns:
        A formatted greeting string.
    """
    return f"{greeting}, {name}!"


class Calculator:
    """A simple calculator class."""

    def __init__(self, initial_value: float = 0) -> None:
        self.value = initial_value

    def add(self, x: float) -> "Calculator":
        """Add a number to the current value."""
        self.value += x
        return self

    def subtract(self, x: float) -> "Calculator":
        """Subtract a number from the current value."""
        self.value -= x
        return self

    def multiply(self, x: float) -> "Calculator":
        """Multiply the current value by a number."""
        self.value *= x
        return self

    def get_value(self) -> float:
        """Return the current value."""
        return self.value


def process_items(items: List[str], prefix: Optional[str] = None) -> List[str]:
    """Process a list of items with an optional prefix."""
    if prefix:
        return [f"{prefix}: {item}" for item in items]
    return items


# Usage example
if __name__ == "__main__":
    message = greet("World")
    print(message)

    calc = Calculator(10)
    result = calc.add(5).multiply(2).get_value()
    print(f"Result: {result}")

    items = process_items(["a", "b", "c"], prefix="Item")
    print(items)
