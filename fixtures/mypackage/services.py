"""Business logic services."""

from typing import Optional, List
from .models import User, Product
from .utils import validate_email, format_price


class UserService:
    """Service for user operations."""

    def __init__(self):
        self._users: dict[int, User] = {}
        self._next_id: int = 1

    def create_user(self, username: str, email: str) -> User:
        """
        Create a new user.

        Args:
            username: User's username
            email: User's email address

        Returns:
            The created user

        Raises:
            ValueError: If email is invalid
        """
        if not validate_email(email):
            raise ValueError(f"Invalid email address: {email}")

        from datetime import datetime

        user = User(
            id=self._next_id,
            username=username,
            email=email,
            created_at=datetime.now(),
        )
        self._users[user.id] = user
        self._next_id += 1
        return user

    def get_user(self, user_id: int) -> Optional[User]:
        """Get a user by ID."""
        return self._users.get(user_id)

    def get_all_users(self) -> List[User]:
        """Get all users."""
        return list(self._users.values())

    def deactivate_user(self, user_id: int) -> bool:
        """
        Deactivate a user account.

        Args:
            user_id: The user's ID

        Returns:
            True if user was deactivated, False if not found
        """
        user = self.get_user(user_id)
        if user:
            user.deactivate()
            return True
        return False


class ProductService:
    """Service for product operations."""

    def __init__(self):
        self._products: dict[int, Product] = {}
        self._next_id: int = 1

    def create_product(
        self,
        name: str,
        price: float,
        description: Optional[str] = None,
    ) -> Product:
        """
        Create a new product.

        Args:
            name: Product name
            price: Product price
            description: Optional description

        Returns:
            The created product
        """
        product = Product(
            id=self._next_id,
            name=name,
            price=price,
            description=description,
        )
        self._products[product.id] = product
        self._next_id += 1
        return product

    def get_product(self, product_id: int) -> Optional[Product]:
        """Get a product by ID."""
        return self._products.get(product_id)

    def get_products_by_tag(self, tag: str) -> List[Product]:
        """Get all products with a specific tag."""
        return [p for p in self._products.values() if tag in p.tags]

    def get_formatted_price(self, product_id: int, currency: str = "USD") -> Optional[str]:
        """
        Get the formatted price of a product.

        Args:
            product_id: The product's ID
            currency: Currency code

        Returns:
            Formatted price or None if product not found
        """
        product = self.get_product(product_id)
        if product:
            return format_price(product.price, currency)
        return None

    def apply_discount_to_all(self, percentage: float) -> dict[int, float]:
        """
        Apply discount to all products.

        Args:
            percentage: Discount percentage

        Returns:
            Dict mapping product ID to new price
        """
        return {
            product_id: product.apply_discount(percentage)
            for product_id, product in self._products.items()
        }
