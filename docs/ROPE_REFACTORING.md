# Rope Refactoring Features for LLMs

## Overview

Rope provides many refactoring capabilities. This document analyzes which features are most valuable for LLM agents and prioritizes them for implementation in python-lsp-mcp.

## Feature Priority Matrix

| Feature | LLM Value | Complexity | Priority | Status |
|---------|-----------|------------|----------|--------|
| **Rename** | Very High | Low | P0 | ✅ Implemented |
| **Move Function/Class** | Very High | Medium | P0 | ✅ Implemented |
| **Change Signature** | Very High | High | P0 | ✅ Implemented |
| **Extract Method** | Very High | Medium | P1 | Planned |
| **Extract Variable** | High | Low | P1 | Planned |
| **Inline Variable** | High | Low | P2 | Planned |
| **Inline Method** | Medium | Medium | P2 | Planned |
| **Move Module** | Medium | Medium | P3 | - |
| **Encapsulate Field** | Low | Medium | P4 | - |
| **Introduce Factory** | Low | High | P4 | - |
| **Restructuring** | Low | Very High | P5 | - |

## Why These Features Matter for LLMs

### P0: Critical (Already Implemented)

#### Rename
- **Use case**: LLMs frequently need to rename variables, functions, classes for clarity
- **Why valuable**: Ensures all references are updated correctly across files
- **Rope API**: `rope.refactor.rename.Rename`

#### Move Function/Class
- **Use case**: LLMs often need to reorganize code into better module structure
- **Why valuable**:
  - Automatically updates all imports across the codebase
  - LLMs struggle with manual import updates across files
  - Prevents broken imports after refactoring
- **Rope API**: `rope.refactor.move.MoveGlobal`

```python
# Example: Move helper function to utils module
move(file="main.py", line=10, column=5, destination="utils.py")

# Result: Function moved, all imports updated automatically
# - main.py: function removed, import added
# - other_file.py: from main import foo → from utils import foo
```

#### Change Signature
- **Use case**: LLMs often need to add/remove/reorder function parameters
- **Why valuable**:
  - Automatically updates all call sites across files
  - LLMs frequently miss call sites when manually updating
  - Handles default values and keyword arguments correctly
- **Rope API**: `rope.refactor.change_signature.ChangeSignature`

```python
# Example: Add 'timeout' parameter to function
change_signature(file, line, col, add_param="timeout", add_param_default="30")

# Result: All callers updated automatically
# - def fetch(url) → def fetch(url, timeout=30)
# - fetch(url) → fetch(url) (default used)
# - fetch(url, timeout=60) → works if explicitly passed
```

### P1: High Priority (Next to Implement)

#### Extract Method
- **Use case**: LLMs often identify code that should be extracted into a function
- **Why valuable**:
  - Reduces code duplication
  - Improves readability
  - LLMs can suggest "this block should be a function" and actually perform it
- **Rope API**: `rope.refactor.extract.ExtractMethod`

```python
# Before
def process():
    # ... 20 lines of validation ...
    # ... main logic ...

# After (LLM extracts validation)
def validate():
    # ... 20 lines of validation ...

def process():
    validate()
    # ... main logic ...
```

#### Extract Variable
- **Use case**: LLMs identify complex expressions that need naming
- **Why valuable**:
  - Makes code self-documenting
  - Enables reuse of computed values
- **Rope API**: `rope.refactor.extract.ExtractVariable`

```python
# Before
if user.age >= 18 and user.country in ALLOWED_COUNTRIES and user.verified:
    grant_access()

# After
is_eligible = user.age >= 18 and user.country in ALLOWED_COUNTRIES and user.verified
if is_eligible:
    grant_access()
```

### P2: Medium Priority

#### Inline Variable
- **Use case**: Remove unnecessary intermediate variables
- **Why valuable**: Simplifies code when variable adds no clarity
- **Rope API**: `rope.refactor.inline.InlineVariable`

#### Inline Method
- **Use case**: Remove trivial wrapper functions
- **Why valuable**: Reduces indirection when function is too simple
- **Rope API**: `rope.refactor.inline.InlineMethod`

#### Move Function/Class
- **Use case**: Reorganize code to better modules
- **Why valuable**:
  - LLMs can suggest better module organization
  - Automatically updates all imports
- **Rope API**: `rope.refactor.move.MoveModule`

### P3: Lower Priority

#### Change Signature
- **Use case**: Add/remove/reorder function parameters
- **Why valuable**: Updates all call sites automatically
- **Complexity**: High - needs to handle default values, keyword args
- **Rope API**: `rope.refactor.change_signature.ChangeSignature`

#### Move Module
- **Use case**: Reorganize package structure
- **Rope API**: `rope.refactor.move.MoveModule`

### P4-P5: Specialized (Not Planned)

These features are too specialized or complex for typical LLM use cases:

- **Encapsulate Field**: Convert public attribute to property
- **Introduce Factory**: Replace constructor with factory method
- **Restructuring**: Pattern-based code transformation
- **Replace Method with Method Object**: Complex OOP pattern

## Implementation Plan

### Phase 1: Extract Refactorings
```python
@mcp.tool()
def extract_method(
    file: str,
    start_line: int,
    end_line: int,
    new_name: str
) -> str:
    """Extract selected lines into a new method."""

@mcp.tool()
def extract_variable(
    file: str,
    start_line: int,
    start_column: int,
    end_line: int,
    end_column: int,
    new_name: str
) -> str:
    """Extract expression into a variable."""
```

### Phase 2: Inline Refactorings
```python
@mcp.tool()
def inline_variable(file: str, line: int, column: int) -> str:
    """Inline a variable at the cursor position."""

@mcp.tool()
def inline_method(file: str, line: int, column: int) -> str:
    """Inline a method at the cursor position."""
```

### Phase 3: Move Refactorings
```python
@mcp.tool()
def move_function(
    file: str,
    line: int,
    column: int,
    destination_module: str
) -> str:
    """Move function to another module."""
```

## Rope API Reference

### Extract Method
```python
from rope.refactor.extract import ExtractMethod

extractor = ExtractMethod(
    project,
    resource,
    start_offset,
    end_offset
)
changes = extractor.get_changes(new_name)
project.do(changes)
```

### Extract Variable
```python
from rope.refactor.extract import ExtractVariable

extractor = ExtractVariable(
    project,
    resource,
    start_offset,
    end_offset
)
changes = extractor.get_changes(new_name)
project.do(changes)
```

### Inline
```python
from rope.refactor.inline import create_inline

inliner = create_inline(project, resource, offset)
changes = inliner.get_changes()
project.do(changes)
```

### Move
```python
from rope.refactor.move import MoveModule, MoveGlobal

# For functions/classes
mover = MoveGlobal(project, resource, offset)
changes = mover.get_changes(dest_module)
project.do(changes)
```

## Notes

1. **Preview Changes**: All refactorings should return a preview before applying
2. **Cross-file**: Rope handles updating imports automatically
3. **Undo Support**: Consider leveraging Rope's undo/redo capability
4. **Error Handling**: Rope raises specific exceptions for invalid refactorings

## References

- [Rope Documentation](https://rope.readthedocs.io/)
- [Rope Refactoring Overview](https://rope.readthedocs.io/en/latest/overview.html)
- [Rope API Reference](https://rope.readthedocs.io/en/latest/library.html)
