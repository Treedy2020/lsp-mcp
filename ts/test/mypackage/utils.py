"""Utility functions for the application."""

import re
from typing import Optional


def format_price(price: float, currency: str = "USD") -> str:
    """
    Format a price with currency symbol.

    Args:
        price: The price value
        currency: Currency code (USD, EUR, CNY)

    Returns:
        Formatted price string
    """
    symbols = {
        "USD": "$",
        "EUR": "€",
        "CNY": "¥",
    }
    symbol = symbols.get(currency, currency)
    return f"{symbol}{price:.2f}"


def validate_email(email: str) -> bool:
    """
    Validate an email address format.

    Args:
        email: Email address to validate

    Returns:
        True if valid, False otherwise
    """
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email))


def truncate_text(text: str, max_length: int, suffix: str = "...") -> str:
    """
    Truncate text to a maximum length.

    Args:
        text: Text to truncate
        max_length: Maximum length
        suffix: Suffix to add when truncated

    Returns:
        Truncated text
    """
    if len(text) <= max_length:
        return text
    return text[:max_length - len(suffix)] + suffix


def parse_tags(tag_string: str, separator: str = ",") -> list[str]:
    """
    Parse a tag string into a list of tags.

    Args:
        tag_string: Comma-separated tags
        separator: Separator character

    Returns:
        List of trimmed tags
    """
    return [tag.strip() for tag in tag_string.split(separator) if tag.strip()]
