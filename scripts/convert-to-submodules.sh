#!/bin/bash
set -e

# Configuration
ORG="Treedy2020"

convert_backend() {
    local PATH_PREFIX=$1
    local REPO_NAME=$2
    local REPO_URL="https://github.com/$ORG/$REPO_NAME.git"

    echo "🔄 Converting $PATH_PREFIX to submodule..."

    if [ -d "$PATH_PREFIX" ]; then
        # Remove from git index
        # We use 'git rm -r' which stages the deletion. 
        # --ignore-unmatch allows it to succeed if files are already gone from index but present on disk
        git rm -r --ignore-unmatch "$PATH_PREFIX"
        
        # Force delete the directory content (node_modules, dist, etc.)
        # This is required for git submodule add to work
        echo "🗑️  Cleaning up directory..."
        rm -rf "$PATH_PREFIX"
    fi
    
    # Add submodule
    echo "➕ Adding submodule $REPO_URL..."
    git submodule add "$REPO_URL" "$PATH_PREFIX"
    
    echo "✅ Added submodule $REPO_NAME at $PATH_PREFIX"
    echo ""
}

echo "🔥 Converting backends to submodules..."

# Ensure we are at root
cd "$(dirname "$0")/.."

convert_backend "backends/typescript/typescript-lsp-mcp" "typescript-lsp-mcp"
convert_backend "backends/vue/vue-lsp-mcp" "vue-lsp-mcp"
convert_backend "backends/python/python-lsp-mcp" "python-lsp-mcp"

echo "🎉 Conversion complete!"
echo "👉 Run 'git status' to verify changes."
echo "👉 Run 'git commit -m \"refactor: replace backend code with git submodules\"' to finalize."