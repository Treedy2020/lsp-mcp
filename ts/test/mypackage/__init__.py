"""A sample package for testing cross-file LSP features."""

from .models import User, Product
from .utils import format_price, validate_email
from .services import UserService, ProductService

__all__ = [
    'User',
    'Product',
    'format_price',
    'validate_email',
    'UserService',
    'ProductService',
]
