#!/bin/bash
echo "============================================"
echo "  Voice Live HAR Visualizer"
echo "  http://localhost:8066"
echo "============================================"
echo ""
echo "Starting local server... Press Ctrl+C to stop."
echo ""

# Open browser (works on macOS and Linux)
if command -v xdg-open &> /dev/null; then
    xdg-open http://localhost:8066 &
elif command -v open &> /dev/null; then
    open http://localhost:8066 &
fi

python3 -m http.server 8066 || python -m http.server 8066
