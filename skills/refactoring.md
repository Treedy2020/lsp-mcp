# Refactoring Skill

Perform safe, cross-file refactoring operations.

## Why Use These Tools

LLMs struggle with:
- Updating imports across multiple files
- Finding and updating all call sites
- Maintaining consistency in large codebases

These tools handle cross-file updates **atomically and correctly**.

## Tools

### rename

Rename a symbol across the entire codebase.

```
rename(file, line, column, new_name)
```

**Use when:**
- Renaming a function, class, method, or variable
- The symbol is used in multiple files
- You need guaranteed consistency

**Example workflow:**
```
User: Rename UserService to AccountService
Agent: [calls rename("services/user.py", 12, 7, "AccountService")]
       → changed_files: ["services/user.py", "api/routes.py", "tests/test_user.py"]
```

**Important:**
- Position must be on the symbol's DEFINITION, not a usage
- All files are updated atomically
- Imports are updated automatically

### move

Move a function or class to another module.

```
move(file, line, column, destination, preview=False)
```

**Use when:**
- Reorganizing code structure
- Extracting code to a utility module
- Moving code to reduce circular imports

**Example workflow:**
```
User: Move validate_email to utils.py
Agent: [calls move("user.py", 45, 5, "utils.py")]
       → changed_files: ["user.py", "utils.py", "api/auth.py"]
       # validate_email moved to utils.py
       # Old location now imports from utils
       # All callers updated to import from utils
```

**Preview mode:**
```
Agent: [calls move(..., preview=True)]
       → Shows what would change without applying
```

### change_signature

Modify function parameters and update all call sites.

```
change_signature(file, line, column,
    new_params=None,       # Reorder: ["self", "b", "a"]
    add_param=None,        # Add: {"name": "x", "default": "None", "index": 1}
    remove_param=None,     # Remove: "old_param"
    preview=False
)
```

**Use when:**
- Adding a new parameter with a default value
- Removing an unused parameter
- Reordering parameters for better API design

**Example: Add parameter**
```
User: Add a 'timeout' parameter to fetch_data with default 30
Agent: [calls function_signature("api.py", 20, 5)]
       → params: ["url", "headers"]
Agent: [calls change_signature("api.py", 20, 5,
         add_param={"name": "timeout", "default": "30"})]
       → All callers remain working (use default value)
```

**Example: Remove parameter**
```
User: Remove the deprecated 'legacy' parameter
Agent: [calls change_signature("api.py", 20, 5, remove_param="legacy")]
       → Parameter removed, all call sites updated
```

**Example: Reorder parameters**
```
User: Put 'config' before 'data' in process()
Agent: [calls function_signature("api.py", 30, 5)]
       → params: ["self", "data", "config"]
Agent: [calls change_signature("api.py", 30, 5,
         new_params=["self", "config", "data"])]
       → All call sites reordered to match
```

### function_signature

Inspect a function's current signature before refactoring.

```
function_signature(file, line, column)
```

**Always call this before change_signature** to understand current state.

## Refactoring Patterns

### Pattern 1: Safe Rename

```
1. references() to see impact
2. Confirm with user if many files affected
3. rename() to apply
4. diagnostics() to verify no errors
```

### Pattern 2: Extract to Module

```
1. Identify code to move
2. move(preview=True) to see impact
3. Confirm destination with user
4. move() to apply
5. diagnostics() to verify
```

### Pattern 3: API Evolution

```
1. function_signature() to see current params
2. change_signature(preview=True) to verify
3. change_signature() to apply
4. Update docstrings manually if needed
```

## Tips

- **Preview first**: Use `preview=True` for complex changes
- **Check diagnostics after**: Run `diagnostics()` to catch any issues
- **Position on definition**: All refactoring tools need position on the DEFINITION
- **Atomic changes**: All affected files are updated together - no partial states
- **Git-friendly**: Changes are written to disk, easy to review with `git diff`
