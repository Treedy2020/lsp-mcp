#!/bin/bash
set -e

# Base directories
ROOT_DIR=$(pwd)
DIST_DIR="$ROOT_DIR/dist/release"

echo "🚀 Preparing release artifacts..."
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# --- Function to prepare NPM package ---
prepare_npm_package() {
    local NAME=$1
    local SRC_DIR=$2
    local OUT_DIR="$DIST_DIR/$NAME"
    
    echo "📦 Packaging $NAME..."
    mkdir -p "$OUT_DIR"
    
    # Build
    cd "$SRC_DIR"
    echo "   Building in $SRC_DIR..."
    bun install
    bun run build
    
    # Copy essential files
    cp package.json README.md "$OUT_DIR/"
    cp -r dist "$OUT_DIR/"
    
    # Create tarball (optional, just for verification)
    # cd "$OUT_DIR"
    # npm pack --pack-destination "$DIST_DIR"
    
    cd "$ROOT_DIR"
    echo "✅ $NAME ready in $OUT_DIR"
}

# --- Function to prepare Python package ---
prepare_python_package() {
    local NAME=$1
    local SRC_DIR=$2
    
    echo "📦 Packaging $NAME..."
    
    cd "$SRC_DIR"
    echo "   Building in $SRC_DIR..."
    rm -rf dist
    uv build
    
    # Copy dist artifacts
    cp -r dist/* "$DIST_DIR/"
    
    cd "$ROOT_DIR"
    echo "✅ $NAME packaged to $DIST_DIR"
}

# --- Execute ---

# 1. TypeScript Backend
if [ -d "backends/typescript/typescript-lsp-mcp" ]; then
    prepare_npm_package "typescript-lsp-mcp" "backends/typescript/typescript-lsp-mcp"
else
    echo "⚠️ Skipping TypeScript backend (not found)"
fi

# 2. Vue Backend
if [ -d "backends/vue/vue-lsp-mcp" ]; then
    prepare_npm_package "vue-lsp-mcp" "backends/vue/vue-lsp-mcp"
else
    echo "⚠️ Skipping Vue backend (not found)"
fi

# 3. Python Backend
if [ -d "backends/python/python-lsp-mcp" ]; then
    prepare_python_package "python-lsp-mcp" "backends/python/python-lsp-mcp"
else
    echo "⚠️ Skipping Python backend (not found)"
fi

echo ""
echo "🎉 Release artifacts ready in dist/release/"
echo ""
echo "--- Git Split Instructions (for separating repositories) ---"
echo "Run these commands manually to push each backend to its own repo:"
echo ""
echo "# 1. TypeScript Backend"
echo "git subtree split --prefix=backends/typescript/typescript-lsp-mcp -b split/typescript"
echo "git push https://github.com/Treedy2020/typescript-lsp-mcp.git split/typescript:main"
echo ""
echo "# 2. Vue Backend"
echo "git subtree split --prefix=backends/vue/vue-lsp-mcp -b split/vue"
echo "git push https://github.com/Treedy2020/vue-lsp-mcp.git split/vue:main"
echo ""
echo "# 3. Python Backend"
echo "git subtree split --prefix=backends/python/python-lsp-mcp -b split/python"
echo "git push https://github.com/Treedy2020/python-lsp-mcp.git split/python:main"
echo ""
