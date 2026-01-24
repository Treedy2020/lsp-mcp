"""Data models for the application."""

from dataclasses import dataclass
from typing import Optional, List
from datetime import datetime


@dataclass
class User:
    """Represents a user in the system."""

    id: int
    username: str
    email: str
    created_at: datetime
    is_active: bool = True

    def get_display_name(self) -> str:
        """Return the display name for the user."""
        return f"@{self.username}"

    def deactivate(self) -> None:
        """Deactivate this user account."""
        self.is_active = False


@dataclass
class Product:
    """Represents a product in the catalog."""

    id: int
    name: str
    price: float
    description: Optional[str] = None
    tags: Optional[List[str]] = None

    def __post_init__(self):
        if self.tags is None:
            self.tags = []

    def apply_discount(self, percentage: float) -> float:
        """
        Apply a discount to the product price.

        Args:
            percentage: Discount percentage (0-100)

        Returns:
            The discounted price
        """
        if not 0 <= percentage <= 100:
            raise ValueError("Discount percentage must be between 0 and 100")
        return self.price * (1 - percentage / 100)

    def add_tag(self, tag: str) -> None:
        """Add a tag to the product."""
        if self.tags is None:
            self.tags = []
        if tag not in self.tags:
            self.tags.append(tag)
