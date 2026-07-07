#!/bin/sh
# F8: MCP stdio bridge entrypoint (Node image).
set -eu
exec node /skill/invoke.mjs
