# Code Navigation Skill

Navigate multi-language codebases efficiently using unified LSP tools.

## Critical: Workspace Management

**Before doing anything else, always set the active workspace.**

```
switch_workspace(path="/path/to/project/root")
```

- This ensures language servers are initialized for the correct project context.
- Files outside the active workspace cannot be accessed (you will get a "Context Mismatch" error).
- **Tip**: You can use relative paths (e.g., `src/main.ts`) once the workspace is set.

## Tools (Unified)

These tools work for **Python (.py)**, **TypeScript/JavaScript (.ts/.js)**, and **Vue (.vue)**.

### hover

Get documentation and type info without reading the file.

```
hover(file, line, column)
```

**Use when:**
- You see a function call and want to know its parameters.
- You need to know the type of a variable.
- **Tip**: Use this *instead* of reading the definition file to save context tokens.

### definition

Find where a symbol is defined.

```
definition(file, line, column)
```

**Use when:**
- You need to read the implementation details.
- You want to jump from usage to source.

### references

Find all usages of a symbol across the project.

```
references(file, line, column)
```

**Use when:**
- Analyzing the impact of a potential change.
- Finding who calls a function.

### symbols

List all classes, functions, and variables in a file.

```
symbols(file, query?)
```

**Use when:**
- You want a high-level overview of a file's structure.
- You are looking for a specific method in a large file.

## Best Practices

### 1. The "Peek" Workflow (Save Tokens)
Instead of reading a file immediately:
1.  `symbols(file)` -> See what's inside.
2.  `hover(file, line, col)` -> Check docstrings of interesting functions.
3.  `read_file(file)` -> Only if you really need the implementation.

### 2. Trace Calls Efficiently
1.  Start at `main.ts` or entry point.
2.  `definition(file, line, col)` to jump to a function.
3.  `switch_workspace` if the definition is in another sub-project (e.g., jumping from `frontend` to `backend`).

### 3. Use Relative Paths
Once workspace is set to `/project/root`, you can simply call:
`hover("src/utils.ts", ...)`
Instead of:
`hover("/project/root/src/utils.ts", ...)`