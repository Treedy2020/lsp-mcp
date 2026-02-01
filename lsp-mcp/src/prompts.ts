/**
 * MCP Prompts for LSP MCP Server Skills
 *
 * Exposes skills documentation as prompts that agents can request
 * to learn best practices for using LSP tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Skills content embedded as strings
const skillsContent = {
  "code-navigation": `# Code Navigation Skill

Navigate Python and TypeScript codebases efficiently using LSP tools.

## When to Use

- Understanding unfamiliar code
- Finding where a function/class is defined
- Tracing how code flows across files
- Getting type information without reading entire files
- **Learning APIs before using them** - hover() and signature_help() provide documentation

## Tools

### hover

Get type info and documentation for a symbol.

\`\`\`
hover(file, line, column)
\`\`\`

**Use when:**
- You need to know the type of a variable
- You want to see a function's signature
- You need docstring without navigating to definition

### definition

Jump to where a symbol is defined.

\`\`\`
definition(file, line, column)
\`\`\`

**Use when:**
- You need to see the implementation
- You want to understand how something works
- User asks "where is X defined?"

### references

Find all usages of a symbol.

\`\`\`
references(file, line, column)
\`\`\`

**Use when:**
- Understanding impact of a change
- Finding all callers of a function
- User asks "where is X used?"

## Navigation Patterns

### Pattern 1: Trace a Call Chain

\`\`\`
1. Start at entry point
2. hover() to understand types
3. definition() to dive deeper
4. Repeat until you understand the flow
\`\`\`

### Pattern 2: Impact Analysis

\`\`\`
1. Find the symbol to change
2. references() to find all usages
3. For each reference, hover() to understand context
4. Plan changes based on impact
\`\`\`

### Pattern 3: Understanding Imports

\`\`\`
1. On imported symbol, definition() to find source
2. symbols() on source file to see what's available
3. hover() on specific items for details
\`\`\`

## Tips

- **Position matters**: Column should point to the START of the symbol
- **Line numbers are 1-based**: First line is 1, not 0
- **Cross-file works automatically**: definition() and references() work across the entire project
- **Use hover first**: It's fast and often gives enough info without needing to read files
- **Learn before coding**: Use hover() to understand method signatures before using APIs
- **Chain with search()**: Use search() to find positions, then navigate with hover/definition/references
- **Always verify**: After making changes, run diagnostics() to catch errors early`,

  refactoring: `# Refactoring Skill

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

\`\`\`
rename(file, line, column, new_name)
\`\`\`

**Use when:**
- Renaming a function, class, method, or variable
- The symbol is used in multiple files
- You need guaranteed consistency

### move

Move a function or class to another module.

\`\`\`
move(file, line, column, destination, preview=False)
\`\`\`

**Use when:**
- Reorganizing code structure
- Extracting code to a utility module
- Moving code to reduce circular imports

### change_signature

Modify function parameters and update all call sites.

\`\`\`
change_signature(file, line, column,
    new_params=None,       # Reorder parameters
    add_param=None,        # Add new parameter
    remove_param=None,     # Remove parameter
    preview=False
)
\`\`\`

### function_signature

Inspect a function's current signature before refactoring.

\`\`\`
function_signature(file, line, column)
\`\`\`

**Always call this before change_signature** to understand current state.

## Refactoring Patterns

### Pattern 1: Safe Rename

\`\`\`
1. references() to see impact
2. Confirm with user if many files affected
3. rename() to apply
4. diagnostics() to verify no errors
\`\`\`

### Pattern 2: Extract to Module

\`\`\`
1. Identify code to move
2. move(preview=True) to see impact
3. Confirm destination with user
4. move() to apply
5. diagnostics() to verify
\`\`\`

## Tips

- **Preview first**: Use preview=True for complex changes
- **Check diagnostics after**: Run diagnostics() to catch any issues
- **Position on definition**: All refactoring tools need position on the DEFINITION
- **Atomic changes**: All affected files are updated together`,

  "code-analysis": `# Code Analysis Skill

Analyze Python and TypeScript code for structure, types, and errors.

## Tools

### symbols

Extract all symbols (classes, functions, variables) from a file.

\`\`\`
symbols(file, query=None)
\`\`\`

**Use when:**
- Getting an overview of a file's structure
- Finding specific symbols by name pattern
- Understanding module organization

### diagnostics

Get type errors and warnings for a file or directory.

\`\`\`
diagnostics(path)
\`\`\`

**Use when:**
- Checking code for type errors after changes
- Validating refactoring didn't break anything
- Finding issues before running tests

### search

Search for patterns across the codebase using regex. Returns positions in LSP format (file, line, column).

\`\`\`
search(pattern, path=None, glob=None, case_sensitive=True, max_results=50)
\`\`\`

**Key Feature: LSP-Ready Positions**

The search tool returns results with exact file, line, and column values that can be directly used with other LSP tools:

\`\`\`
search("UserService") → [{file: "src/user.py", line: 15, column: 7}, ...]
                        ↓
hover(file="src/user.py", line=15, column=7) → Get type info
definition(...) → Jump to definition
references(...) → Find all usages
\`\`\`

## Analysis Patterns

### Pattern 1: Understand a Module

\`\`\`
1. symbols() to get structure overview
2. hover() on key classes/functions for details
3. references() on public APIs to see usage
\`\`\`

### Pattern 2: Validate Changes

\`\`\`
1. Make code changes
2. diagnostics() on affected files
3. Fix any type errors
4. Repeat until clean
\`\`\`

### Pattern 3: Learn API Before Using

\`\`\`
1. search("ClassName") to find where API is defined
2. hover() on the class/function to get documentation
3. symbols() to see available methods
4. signature_help() on methods you'll use
5. Write code with confidence
6. diagnostics() to verify
\`\`\`

## Tips

- **symbols() is fast**: Use it to quickly understand file structure
- **diagnostics() is essential**: Always run after making changes
- **search() returns LSP positions**: Use results directly with hover/definition/references
- **hover() before coding**: Get API documentation before using unfamiliar code`,

  rules: `# LSP MCP Rules

Best practices for agents using the lsp-mcp server (Python + TypeScript).

## Core Principles

### 1. Use LSP Before Reading Files

\`\`\`
GOOD: hover() to get type info → only read if needed
BAD:  Read entire file to understand one variable's type
\`\`\`

LSP tools are faster and more precise than reading and parsing files manually.

### 2. Use Search to Get LSP-Ready Positions

\`\`\`
GOOD: search("className") → get file:line:column → hover/definition/references
BAD:  Manually calculate line numbers from file content
\`\`\`

The search() tool returns positions (file, line, column) that can be directly used with other LSP tools.

### 3. Get Documentation Before Calling Methods

\`\`\`
GOOD: hover()/signature_help() → understand params → write correct code
BAD:  Guess method parameters and hope for the best
\`\`\`

Before using unfamiliar APIs or methods:
1. Use hover() to get type information and documentation
2. Use signature_help() to see exact parameter signatures
3. Then write code with confidence

### 4. Always Verify with Diagnostics After Changes

\`\`\`
GOOD: Edit code → diagnostics() → fix issues → done
BAD:  Edit code → assume it works
\`\`\`

After any code modification:
1. Run diagnostics() on affected files/directories
2. Review and fix any type errors or warnings
3. Repeat until clean

### 5. Use Refactoring Tools for Cross-File Changes

\`\`\`
GOOD: rename() to rename across files
BAD:  Manually edit each file with search-replace
\`\`\`

Refactoring tools guarantee consistency. Manual edits risk missing usages.

## Tool Selection Guide

| Task | Tool | Why |
|------|------|-----|
| "What type is X?" | hover() | Fast, precise |
| "Where is X defined?" | definition() | Jumps across files |
| "Where is X used?" | references() | Finds all usages |
| "What's in this file?" | symbols() | Quick structure overview |
| "Are there type errors?" | diagnostics() | Full type checking |
| "Find pattern in code" | search() | Regex across codebase |
| "Rename X to Y" | rename() | Cross-file, atomic |
| "Move X to other module" | move() | Updates imports |
| "Add/remove parameter" | change_signature() | Updates call sites |

## Position Parameters

All LSP tools use (file, line, column) positions.

### Rules

1. **Line numbers are 1-based**: First line is 1
2. **Column numbers are 1-based**: First character is 1
3. **Point to symbol start**: Position at the FIRST character of the symbol

## Complete Coding Workflow

\`\`\`
1. Understand the task
2. Explore relevant code with symbols/hover/definition
3. Write/edit code
4. diagnostics() → check for errors
5. Fix any issues found
6. Repeat 4-5 until clean
7. [Optional] Run tests
\`\`\`

Always end with diagnostics to ensure code quality.`,
};

import { z } from "zod";

/**
 * Register all skill prompts on the MCP server.
 */
export function registerPrompts(server: McpServer): void {
  // Code Navigation skill
  server.registerPrompt("code-navigation", {
    description: "Learn how to navigate codebases using LSP tools (hover, definition, references)",
  }, async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: skillsContent["code-navigation"],
        },
      },
    ],
  }));

  // Refactoring skill
  server.registerPrompt("refactoring", {
    description: "Learn safe cross-file refactoring operations (rename, move, change_signature)",
  }, async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: skillsContent.refactoring,
        },
      },
    ],
  }));

  // Code Analysis skill
  server.registerPrompt("code-analysis", {
    description: "Learn code analysis techniques (symbols, diagnostics, search)",
  }, async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: skillsContent["code-analysis"],
        },
      },
    ],
  }));

  // Rules / Best Practices
  server.registerPrompt("lsp-rules", {
    description: "Best practices and rules for using LSP tools effectively",
  }, async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: skillsContent.rules,
        },
      },
    ],
  }));

  // Action: Explore Project
  server.registerPrompt("explore-project", {
    description: "Analyze the current project structure and key files using semantic summaries",
    args: {
      path: z.string().optional().describe("Project root path (optional, defaults to active workspace)"),
    }
  }, async ({ path }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Please explore the project at '${path || "current workspace"}'.

Recommended Workflow:
1. List files to understand the directory structure (use 'ls' or 'glob').
2. Identify key entry points (e.g., main.py, index.ts, App.vue, pyproject.toml, package.json).
3. Use 'summarize_file' on these entry points to extract high-level symbols (classes/functions) without reading full content.
4. Report back with a structural summary of the project.`
      }
    }]
  }));

  // Action: Debug File
  server.registerPrompt("debug-file", {
    description: "Deeply analyze a file for errors using diagnostics and inlay hints",
    args: {
      file: z.string().describe("Path to the file to debug"),
    }
  }, async ({ file }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Please debug and analyze the file '${file}'.

Recommended Workflow:
1. Run 'diagnostics' on the file to identify syntax errors, type mismatches, or unused imports.
2. Use 'read_file_with_hints' to read the content. This will reveal inferred types and parameter names, making it easier to spot logic errors.
3. If errors are found, check specific locations with 'code_action' to see if auto-fixes (like 'Organize Imports') are available.
4. Explain the findings and propose fixes.`
      }
    }]
  }));

  // Combined quick reference
  server.registerPrompt("lsp-quick-start", {
    description: "Quick start guide - essential LSP workflow patterns",
  }, async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `# LSP MCP Quick Start

## Key Workflows

### 1. Smart Exploration
Instead of reading raw code, use:
\`\`\`
summarize_file(file) → Get outline of classes/functions
read_file_with_hints(file) → Read code with type/param annotations
\`\`\`

### 2. Search → LSP Tools
\`\`\`
search("ClassName") → get positions
hover(file, line, column) → get type info
definition(...) → jump to definition
references(...) → find usages
\`\`\`

### 3. Debug & Fix
\`\`\`
diagnostics(path) → Check for errors
code_action(file, line, col) → Get quick fixes (e.g. Organize Imports)
run_code_action(...) → Apply fix
\`\`\`

## Tool Namespacing
Tools are unified! Just provide the file path, and the server auto-detects the language (Python/TS/Vue).
`,
        },
      },
    ],
  }));
}
