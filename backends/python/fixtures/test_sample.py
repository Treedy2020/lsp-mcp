"""Test Python file for LSP MCP testing."""

def greet(name: str) -> str:
    """Greet a person by name."""
    return f"Hello, {name}!"

class Calculator:
    """A simple calculator class."""

    def add(self, a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    def subtract(self, a: int, b: int) -> int:
        """Subtract b from a."""
        return a - b


if __name__ == "__main__":
    calc = Calculator()
    print(greet("World"))
    print(calc.add(1, 2))
