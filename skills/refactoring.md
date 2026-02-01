# Refactoring Skill

Perform safe, cross-file refactoring operations using unified and language-specific tools.

## The Golden Rule
**Always run `diagnostics(path=".")` BEFORE and AFTER any refactoring.**
- Before: Ensure codebase is clean (tools work best on valid code).
- After: Verify no regressions were introduced.

## Universal Tools (All Languages)

### rename

Rename a symbol (class, function, variable) across the entire project.

```
rename(file, line, column, newName)
```

**Why use this instead of search/replace?**
- It understands scoping (won't rename local variables with the same name in other functions).
- It updates imports automatically.
- It handles multiple files safely.

## Language-Specific Advanced Refactoring

Some tools are only available for specific languages. They are registered with prefixes.

### Python (`python_` prefix)

#### python_move
Move a symbol to another module.
```
python_move(file, line, column, destination)
```
*   **Example**: Move `User` class from `models.py` to `domain/user.py`. All imports in the project will be updated.

#### python_change_signature
Modify function parameters safely.
```
python_change_signature(file, line, col, add_param={...}, remove_param="...")
```

### TypeScript (`typescript_` prefix)

#### typescript_move
Move to file.
```
typescript_move(file, line, col, destination)
```

#### typescript_available_refactors
See what actions TS server recommends (e.g., "Extract function", "Convert to named function").
```
typescript_available_refactors(file, line, col)
```

#### typescript_apply_refactor
Apply a recommendation.
```
typescript_apply_refactor(..., refactorName, actionName)
```

## Refactoring Workflow

1.  **Preparation**:
    ```
    switch_workspace(...)
    diagnostics(".")
    ```
2.  **Analysis**:
    ```
    references(file, line, col) -> See impact
    ```
3.  **Execution**:
    ```
    rename(...) OR python_move(...)
    ```
4.  **Verification**:
    ```
    diagnostics(".") -> Should be clean
    git diff -> Double check changes
    ```