#!/bin/sh
# dterm shim-launcher: exec the node binary the extension provided. Both
# DTERM_NODE_BIN and DTERM_STUB_JS are set in TerminalOptions.env by
# buildBootstrapStubOptions; if either is missing something has gone
# very wrong with the bootstrap setup, fail loudly rather than silently.
if [ -z "${DTERM_NODE_BIN:-}" ] || [ -z "${DTERM_STUB_JS:-}" ]; then
    echo "dterm-shim-launcher: DTERM_NODE_BIN or DTERM_STUB_JS not set in env" >&2
    exit 2
fi
exec "$DTERM_NODE_BIN" "$DTERM_STUB_JS" "$@"
