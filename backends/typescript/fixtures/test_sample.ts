/**
 * Test TypeScript file for LSP MCP testing.
 */

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}

const calc = new Calculator();
console.log(greet("World"));
console.log(calc.add(1, 2));
