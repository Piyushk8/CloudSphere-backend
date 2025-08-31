#!/bin/bash

CONFIG="${1:-/workspace/run.config.json}"  # fallback to /workspace

[ ! -f "$CONFIG" ] && echo "No config found at $CONFIG" && exit 1

LANGUAGE=$(jq -r '.language' "$CONFIG")
ENTRY=$(jq -r '.entry // ""' "$CONFIG")
PROJECT_DIR=$(jq -r '.project_dir // "."' "$CONFIG")
BUILD=$(jq -r '.build // ""' "$CONFIG")
RUN=$(jq -r '.run // ""' "$CONFIG")
START_DELAY=$(jq -r '.start_delay // 0' "$CONFIG")
MAIN_CLASS=$(jq -r '.main_class // ""' "$CONFIG")

# Export env variables
jq -r '.env // {} | to_entries[] | "export \(.key)=\(.value)"' "$CONFIG" | while read -r line; do
  eval "$line"
done

cd "$PROJECT_DIR" || exit 1

if [ -n "$BUILD" ]; then
  echo "🔧 Build: $BUILD"
  eval "$BUILD" || { echo "❌ Build failed"; exit 1; }
fi

if [ "$START_DELAY" -gt 0 ]; then
  echo "⏳ Waiting $START_DELAY seconds..."
  sleep "$START_DELAY"
fi

echo "🚀 Running: $RUN"
eval "$RUN"
