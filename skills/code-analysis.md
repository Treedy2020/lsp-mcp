# Code Analysis Skill

Analyze Python and TypeScript code for structure, types, and errors.

## Tools

### symbols

Extract all symbols (classes, functions, variables) from a file.

```
symbols(file, query=None)
```

**Use when:**
- Getting an overview of a file's structure
- Finding specific symbols by name pattern
- Understanding module organization

**Example: File overview**
```
Agent: [calls symbols("services/user.py")]
       → symbols: [
           {"name": "UserService", "kind": "class", "line": 12},
           {"name": "__init__", "kind": "method", "line": 15},
           {"name": "create_user", "kind": "method", "line": 25},
           {"name": "get_user", "kind": "method", "line": 45},
           {"name": "DEFAULT_ROLE", "kind": "variable", "line": 8}
         ]
```

**Example: Filter by query**
```
Agent: [calls symbols("api.py", query="get")]
       → symbols: [
           {"name": "get_user", "kind": "function", "line": 20},
           {"name": "get_orders", "kind": "function", "line": 35}
         ]
```

### diagnostics

Get type errors and warnings for a file or directory.

```
diagnostics(path)
```

**Use when:**
- Checking code for type errors after changes
- Validating refactoring didn't break anything
- Finding issues before running tests

**Example: Single file**
```
Agent: [calls diagnostics("api/routes.py")]
       → diagnostics: [
           {
             "file": "api/routes.py",
             "line": 45,
             "severity": "error",
             "message": "Argument of type 'str' cannot be assigned to parameter 'user_id' of type 'int'"
           }
         ]
```

**Example: Entire directory**
```
Agent: [calls diagnostics("src/")]
       → diagnostics: [...all errors in src/]
```

### search

Search for patterns across the codebase using regex. Returns positions in LSP format (file, line, column).

```
search(pattern, path=None, glob=None, case_sensitive=True, max_results=50)
```

**Key Feature: LSP-Ready Positions**

The search tool returns results with exact `file`, `line`, and `column` values that can be directly used with other LSP tools:

```
search("UserService") → [{"file": "src/user.py", "line": 15, "column": 7}, ...]
                        ↓
hover(file="src/user.py", line=15, column=7) → Get type info
definition(...) → Jump to definition
references(...) → Find all usages
```

This makes search() the perfect entry point for LSP-based workflows.

**Use when:**
- Finding all occurrences of a pattern with exact positions
- Preparing inputs for batch LSP operations
- Locating TODOs, FIXMEs, or other markers
- Searching for specific code constructs

**Example: Find and analyze pattern**
```
Agent: [calls search("deprecated", path="src/")]
       → results: [
           {"file": "src/api.py", "line": 23, "column": 5},
           {"file": "src/utils.py", "line": 89, "column": 9}
         ]
Agent: [calls hover("src/api.py", 23, 5)]
       → Get context for the deprecated item
```

**Example: Find function calls**
```
Agent: [calls search(r"\.send_email\(", path="src/")]
       → All places where send_email is called, with exact positions
```

**Example: Filter by file type**
```
Agent: [calls search("import redis", glob="*.py")]
       → Only search in Python files
```

**Example: Chain with other LSP tools**
```
# Find all usages of a deprecated method
Agent: [calls search("old_method")]
       → Get all positions
Agent: For each position:
       [calls references(file, line, column)]
       → Find what calls each occurrence
```

## Analysis Patterns

### Pattern 1: Understand a Module

```
1. symbols() to get structure overview
2. hover() on key classes/functions for details
3. references() on public APIs to see usage
```

### Pattern 2: Validate Changes

```
1. Make code changes
2. diagnostics() on affected files
3. Fix any type errors
4. Repeat until clean
```

### Pattern 3: Find and Fix Pattern

```
1. search() to find all occurrences
2. For each result, read context
3. Apply fix or refactoring tool
4. diagnostics() to verify
```

### Pattern 4: Codebase Exploration

```
1. symbols() on entry point (main.py, app.py)
2. definition() to explore key components
3. search() for specific patterns of interest
4. Build mental model of architecture
```

### Pattern 5: Learn API Before Using

```
1. search("ClassName") to find where API is defined
2. hover() on the class/function to get documentation
3. symbols() to see available methods
4. signature_help() on methods you'll use
5. Write code with confidence
6. diagnostics() to verify
```

### Pattern 6: Complete Coding Cycle

```
1. Explore: symbols(), hover(), definition()
2. Code: Write/Edit
3. Verify: diagnostics()
4. Fix: Address any errors
5. Repeat 3-4 until clean
```

Always end with diagnostics() - this is critical for code quality.

## Tips

- **symbols() is fast**: Use it to quickly understand file structure
- **diagnostics() is essential**: Always run after making changes
- **search() returns LSP positions**: Use results directly with hover/definition/references
- **hover() before coding**: Get API documentation before using unfamiliar code
- **Combine tools**: search() → hover() → definition() → Edit → diagnostics() is the complete workflow
- **Check after refactoring**: Always run diagnostics() after rename/move/change_signature
- **Batch diagnostics**: Run once after all changes, not after each small edit
