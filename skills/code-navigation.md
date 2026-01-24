# Code Navigation Skill

Navigate Python codebases efficiently using LSP tools.

## When to Use

- Understanding unfamiliar code
- Finding where a function/class is defined
- Tracing how code flows across files
- Getting type information without reading entire files

## Tools

### hover

Get type info and documentation for a symbol.

```
hover(file, line, column)
```

**Use when:**
- You need to know the type of a variable
- You want to see a function's signature
- You need docstring without navigating to definition

**Example workflow:**
```
User: What type is `result` on line 42?
Agent: [calls hover(file, 42, 10)]
       → "result: list[User]"
```

### definition

Jump to where a symbol is defined.

```
definition(file, line, column)
```

**Use when:**
- You need to see the implementation
- You want to understand how something works
- User asks "where is X defined?"

**Example workflow:**
```
User: Show me the UserService class
Agent: [calls definition(file, 15, 8)]  # on 'UserService' usage
       → file: "services/user.py", line: 12
Agent: [reads services/user.py]
```

### references

Find all usages of a symbol.

```
references(file, line, column)
```

**Use when:**
- Understanding impact of a change
- Finding all callers of a function
- User asks "where is X used?"

**Example workflow:**
```
User: Where is calculate_total used?
Agent: [calls references(file, 20, 5)]  # on function definition
       → [
           {"file": "orders.py", "line": 45},
           {"file": "cart.py", "line": 112},
           {"file": "tests/test_calc.py", "line": 23}
         ]
```

## Navigation Patterns

### Pattern 1: Trace a Call Chain

```
1. Start at entry point
2. hover() to understand types
3. definition() to dive deeper
4. Repeat until you understand the flow
```

### Pattern 2: Impact Analysis

```
1. Find the symbol to change
2. references() to find all usages
3. For each reference, hover() to understand context
4. Plan changes based on impact
```

### Pattern 3: Understanding Imports

```
1. On imported symbol, definition() to find source
2. symbols() on source file to see what's available
3. hover() on specific items for details
```

## Tips

- **Position matters**: Column should point to the START of the symbol
- **Line numbers are 1-based**: First line is 1, not 0
- **Cross-file works automatically**: definition() and references() work across the entire project
- **Use hover first**: It's fast and often gives enough info without needing to read files
