/**
 * Test TypeScript file for typescript-lsp-mcp.
 */

interface User {
  id: number;
  name: string;
  email: string;
}

class UserService {
  private users: Map<number, User> = new Map();

  /**
   * Create a new user.
   * @param name - The user's name
   * @param email - The user's email
   * @returns The created user
   */
  createUser(name: string, email: string): User {
    const id = this.users.size + 1;
    const user: User = { id, name, email };
    this.users.set(id, user);
    return user;
  }

  /**
   * Get a user by ID.
   */
  getUser(id: number): User | undefined {
    return this.users.get(id);
  }

  /**
   * Get all users.
   */
  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }
}

function greet(user: User): string {
  return `Hello, ${user.name}!`;
}

// Usage
const service = new UserService();
const alice = service.createUser("Alice", "alice@example.com");
console.log(greet(alice));
