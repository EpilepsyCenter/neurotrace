#!/bin/bash
# Development launcher — starts Python backend + Electron/Vite frontend

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Starting NeuroTrace development environment..."

# Install Python dependencies if needed
if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "Installing Python dependencies..."
    pip3 install -r "$PROJECT_DIR/backend/requirements.txt"
fi

# Install Node dependencies if needed
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    echo "Installing Node dependencies..."
    cd "$PROJECT_DIR" && npm install
fi

# Start both servers
cd "$PROJECT_DIR"
npm run dev
