"""
Test file for cross-file LSP features.

This file imports from mypackage to test:
- Go to definition across files
- Find references across files
- Hover information for imported symbols
- Completions from imported modules
"""

from mypackage import User, Product, UserService, ProductService
from mypackage.utils import format_price, validate_email, truncate_text


def main():
    # Test UserService
    user_service = UserService()

    # Create a user - hover over create_user to see signature
    alice = user_service.create_user("alice", "alice@example.com")
    print(f"Created user: {alice.get_display_name()}")

    # Test ProductService
    product_service = ProductService()

    # Create products
    laptop = product_service.create_product(
        name="Laptop",
        price=999.99,
        description="A powerful laptop",
    )
    laptop.add_tag("electronics")
    laptop.add_tag("computers")

    phone = product_service.create_product(
        name="Phone",
        price=699.99,
    )
    phone.add_tag("electronics")

    # Test cross-file function calls
    price_str = format_price(laptop.price, "USD")
    print(f"Laptop price: {price_str}")

    # Test validation
    is_valid = validate_email(alice.email)
    print(f"Email valid: {is_valid}")

    # Test discount
    discounted = laptop.apply_discount(10)
    print(f"Discounted price: {format_price(discounted, 'USD')}")

    # Get products by tag
    electronics = product_service.get_products_by_tag("electronics")
    print(f"Electronics count: {len(electronics)}")

    # Test truncation
    long_text = "This is a very long description that needs to be truncated"
    short_text = truncate_text(long_text, 20)
    print(f"Truncated: {short_text}")

    # Deactivate user
    user_service.deactivate_user(alice.id)
    print(f"User active: {alice.is_active}")


if __name__ == "__main__":
    main()
