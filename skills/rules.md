# LSP MCP Rules

Best practices for agents using the lsp-mcp server (Python + TypeScript).

## Core Principles

### 1. Use LSP Before Reading Files

```
GOOD: hover() to get type info → only read if needed
BAD:  Read entire file to understand one variable's type
```

LSP tools are faster and more precise than reading and parsing files manually.

### 2. Use Search to Get LSP-Ready Positions

```
GOOD: search("className") → get file:line:column → hover/definition/references
BAD:  Manually calculate line numbers from file content
```

The `search()` tool returns positions (file, line, column) that can be directly used with other LSP tools. This is invaluable for:
- Finding all occurrences of a pattern and getting their exact positions
- Preparing inputs for batch LSP operations
- Navigating large codebases efficiently

### 3. Get Documentation Before Calling Methods

```
GOOD: hover()/signature_help() → understand params → write correct code
BAD:  Guess method parameters and hope for the best
```

Before using unfamiliar APIs or methods:
1. Use `hover()` to get type information and documentation
2. Use `signature_help()` to see exact parameter signatures
3. Then write code with confidence

This prevents errors and reduces iteration cycles.

### 4. Always Verify with Diagnostics After Changes

```
GOOD: Edit code → diagnostics() → fix issues → done
BAD:  Edit code → assume it works
```

After any code modification:
1. Run `diagnostics()` on affected files/directories
2. Review and fix any type errors or warnings
3. Repeat until clean

This catches issues immediately rather than at test/runtime.

### 5. Use Refactoring Tools for Cross-File Changes

```
GOOD: rename() to rename across files
BAD:  Manually edit each file with search-replace
```

Refactoring tools guarantee consistency. Manual edits risk missing usages.

### 6. Preview Before Large Changes

```
GOOD: move(preview=True) → confirm → move()
BAD:  move() directly on unfamiliar code
```

Use preview mode to understand impact before applying.

## Tool Selection Guide

### When to Use Each Tool

| Task | Tool | Why |
|------|------|-----|
| "What type is X?" | `hover()` | Fast, precise |
| "Where is X defined?" | `definition()` | Jumps across files |
| "Where is X used?" | `references()` | Finds all usages |
| "What's in this file?" | `symbols()` | Quick structure overview |
| "Are there type errors?" | `diagnostics()` | Full type checking |
| "Find pattern in code" | `search()` | Regex across codebase |
| "Rename X to Y" | `rename()` | Cross-file, atomic |
| "Move X to other module" | `move()` | Updates imports |
| "Add/remove parameter" | `change_signature()` | Updates call sites |

### Don't Use LSP For

| Task | Use Instead |
|------|-------------|
| Reading file contents | `Read` tool |
| Writing new code | `Write` / `Edit` tools |
| Running code | `Bash` tool |
| Git operations | `Bash` with git |

## Position Parameters

All LSP tools use `(file, line, column)` positions.

### Rules

1. **Line numbers are 1-based**: First line is 1
2. **Column numbers are 1-based**: First character is 1
3. **Point to symbol start**: Position at the FIRST character of the symbol

### Examples

```python
# Line 10:
class UserService:
#     ^-- column 7 (start of 'UserService')

# Line 25:
def create_user(self, name, email):
#   ^-- column 5 (start of 'create_user')

# Line 30:
    user = User(name, email)
#   ^-- column 5 (start of 'user')
#          ^-- column 12 (start of 'User')
```

## Error Handling

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| "No symbol at position" | Wrong line/column | Verify position points to symbol |
| "Cannot find definition" | Symbol not in project | Check if it's from external library |
| "Parameter not found" | Wrong param name | Use `function_signature()` first |
| "Resource not found" | Wrong file path | Use absolute path |

### Recovery Pattern

```
1. If tool fails, check position with hover()
2. If hover() works, retry original tool
3. If hover() fails, adjust position
4. Use symbols() to find correct line numbers
```

## Performance Tips

### Fast Operations (< 1ms)
- `hover()`
- `definition()`
- `symbols()`
- `function_signature()`

### Medium Operations (< 50ms)
- `references()`
- `search()`
- `rename()`
- `move()`
- `change_signature()`

### Slow Operations (< 500ms)
- `diagnostics()` - runs full type check

### Optimization

```
GOOD: hover() multiple times is fine
GOOD: Batch related operations
BAD:  diagnostics() after every small change
GOOD: diagnostics() once after all changes complete
```

## Workflow Templates

### Template 1: Understand and Modify

```
1. symbols(file) → get structure
2. hover(file, line, col) → understand types
3. Make changes
4. diagnostics(file) → verify
```

### Template 2: Safe Refactoring

```
1. references(file, line, col) → see impact
2. [Preview if complex]
3. rename/move/change_signature
4. diagnostics(affected_files) → verify
5. Show user the changed files
```

### Template 3: Codebase Exploration

```
1. symbols(entry_point) → find main components
2. definition() → dive into implementations
3. references() → understand usage patterns
4. search() → find specific patterns
```

### Template 4: Fix Type Errors

```
1. diagnostics(path) → get errors
2. For each error:
   a. Read error context
   b. hover() to understand types
   c. Fix the issue
3. diagnostics(path) → verify all fixed
```

### Template 5: Search-Driven LSP Operations

```
1. search("pattern") → get positions for all matches
2. For each position (file, line, column):
   a. hover() → get type info
   b. references() → understand usage
   c. Apply changes as needed
3. diagnostics() → verify all changes
```

This pattern is powerful because search() returns exact positions that work directly with other LSP tools.

### Template 6: Learn API Before Using

```
1. search("ClassName") → find where it's defined
2. hover(file, line, col) → get class documentation
3. symbols(file) → see all methods
4. For methods you'll use:
   a. hover() → get signature and docs
   b. signature_help() → get detailed params
5. Write code using the API
6. diagnostics() → verify correctness
```

This prevents trial-and-error coding by understanding the API first.

### Template 7: Complete Coding Workflow

```
1. Understand the task
2. Explore relevant code with symbols/hover/definition
3. Write/edit code
4. diagnostics() → check for errors
5. Fix any issues found
6. Repeat 4-5 until clean
7. [Optional] Run tests
```

Always end with diagnostics to ensure code quality.

## Integration with Other Tools

### With Read Tool

```
# Use LSP first, read only when needed
hover() → got type info, no need to read
definition() → got location → Read that specific file
```

### With Edit Tool

```
# Let LSP find locations, use Edit to change
search("pattern") → got locations
Edit each location
diagnostics() → verify
```

### With Bash Tool

```
# Run tests after refactoring
rename(...)
diagnostics(...)
Bash: pytest tests/
```
