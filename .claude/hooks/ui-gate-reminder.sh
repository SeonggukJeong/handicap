#!/usr/bin/env bash
# Compatibility shim (2026-11-20): replaced by commit-gate-reminder.sh. Claude Code sessions
# that were already running when settings.json switched still call this path from the hook
# config they loaded at startup — deleting it made every Bash call in those sessions print
# "No such file or directory". Forward stdin to the new hook so they get its behaviour.
# Safe to delete once no session started before 2026-11-20 is still running.
exec "$(dirname "$0")/commit-gate-reminder.sh"
