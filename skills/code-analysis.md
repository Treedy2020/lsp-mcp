# Code Analysis Skill

Analyze code for structure, types, and errors using unified tools.

## Tools

### diagnostics

Check for errors. **This is your primary quality gate.**

```
diagnostics(path=".")
```

**Use when:**
- Before reading code: Is the project currently healthy?
- After editing code: Did I break anything?
- **Workflow**: `edit` -> `diagnostics` -> `fix` -> `diagnostics`.

### symbols

Get file outline.

```
symbols(file, query=None)
```

**Use when:**
- You open a new file and want to see what methods it has.
- You are looking for a specific method but don't know the exact name (`query="get"`).

### search

Global regex search.

```
search(pattern, path?, glob?)
```

**Features:**
- **No Path**: `search("pattern")` searches the entire active workspace.
- **With Path**: `search("pattern", path="src")` limits scope.
- **With Glob**: `search("pattern", glob="*.py")` limits file type.

## Analysis Workflows

### 1. The "Health Check"
Before starting any task:
1.  `switch_workspace(...)`
2.  `diagnostics(".")`
If there are errors, **fix them first** or at least be aware of them.

### 2. The "Discovery"
When asked to "Find where X happens":
1.  `search("X")` -> Find candidate files.
2.  `symbols(file)` -> Confirm it's the right place.
3.  `hover(file, line, col)` -> Confirm it's the right logic.

### 3. The "Usage Audit"
When deprecating a function:
1.  `references(file, line, col)` -> Find all callers.
2.  `diagnostics(".")` -> Ensure no type errors after removal.