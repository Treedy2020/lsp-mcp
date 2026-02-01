#!/bin/bash
set -e

# Configuration
ORG="Treedy2020"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

process_backend() {
    local NAME=$1
    local PATH_PREFIX=$2
    local REPO_NAME="$NAME"
    local REPO_URL="https://github.com/$ORG/$REPO_NAME.git"
    local SPLIT_BRANCH="split/$NAME"

    echo -e "${BLUE}=== Processing $NAME ===${NC}"

    # 1. Create Repo if not exists
    if gh repo view "$ORG/$REPO_NAME" >/dev/null 2>&1; then
        echo "✅ Repository $ORG/$REPO_NAME already exists."
    else
        echo "🚀 Creating repository $ORG/$REPO_NAME..."
        # Create empty repo (no init) to allow clean push
        gh repo create "$ORG/$REPO_NAME" --public --description "$NAME backend for LSP-MCP"
    fi

    # 2. Split Subtree
    echo "✂️  Splitting subtree from $PATH_PREFIX..."
    # Check if branch exists, delete if so to ensure fresh split
    if git show-ref --verify --quiet "refs/heads/$SPLIT_BRANCH"; then
        git branch -D "$SPLIT_BRANCH"
    fi
    
    # Split!
    git subtree split --prefix="$PATH_PREFIX" -b "$SPLIT_BRANCH"

    # 3. Push to Remote
    echo "⬆️  Pushing to $REPO_URL..."
    git push "$REPO_URL" "$SPLIT_BRANCH:main" --force

    # 4. Cleanup
    echo "🧹 Cleaning up branch $SPLIT_BRANCH..."
    git branch -D "$SPLIT_BRANCH"

    echo -e "${GREEN}✅ Successfully pushed $NAME to $REPO_URL\n"
}

# --- Execute ---

# Ensure we are in root (assuming script is in scripts/)
cd "$(dirname "$0")/.."

echo "🔥 Starting Monorepo Split..."

process_backend "typescript-lsp-mcp" "backends/typescript/typescript-lsp-mcp"
process_backend "vue-lsp-mcp" "backends/vue/vue-lsp-mcp"
process_backend "python-lsp-mcp" "backends/python/python-lsp-mcp"

echo "🎉 All backends have been split and pushed!"
