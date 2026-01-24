# Code Analysis Skill

Analyze Python code for structure, types, and errors.

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

Search for patterns across the codebase using regex.

```
search(pattern, path=None, glob=None, case_sensitive=True, max_results=50)
```

**Use when:**
- Finding all occurrences of a pattern
- Searching for specific code constructs
- Locating TODOs, FIXMEs, or other markers

**Example: Find pattern**
```
Agent: [calls search("TODO:", path="src/")]
       → results: [
           {"file": "src/api.py", "line": 23, "column": 5},
           {"file": "src/utils.py", "line": 89, "column": 9}
         ]
```

**Example: Find function calls**
```
Agent: [calls search(r"\.send_email\(", path="src/")]
       → All places where send_email is called
```

**Example: Filter by file type**
```
Agent: [calls search("import redis", glob="*.py")]
       → Only search in Python files
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

## Tips

- **symbols() is fast**: Use it to quickly understand file structure
- **diagnostics() uses Pyright**: Full type checking, not just syntax
- **search() uses ripgrep**: Very fast, supports full regex
- **Combine tools**: symbols() → hover() → definition() is a powerful pattern
- **Check after refactoring**: Always run diagnostics() after rename/move/change_signature
