#!/usr/bin/env python3
"""Extract a dotted key path from a JSON response read on STDIN.

Usage:  curl -s ... | python3 parse.py [dotted.path]
  - dict keys and list indices:  scenarios.0.id   summary.p50_ms   steps.0.response.body
  - no path  → pretty-print the whole document (UTF-8, indented)

Reading from STDIN (never a shell variable) is the point: the controller's
create responses embed a multiline `scenario_yaml`, and stuffing that JSON into
a zsh variable then echoing it unescapes the `\\n` sequences and corrupts the
JSON before any parser sees it. Piping curl straight into this script avoids
that footgun (json.load handles the escapes correctly).
"""
import json
import sys

doc = json.load(sys.stdin)

if len(sys.argv) < 2:
    json.dump(doc, sys.stdout, indent=2, ensure_ascii=False)
    print()
    sys.exit(0)

cur = doc
for part in sys.argv[1].split("."):
    if isinstance(cur, list):
        cur = cur[int(part)]
    else:
        cur = cur[part]

if isinstance(cur, (dict, list)):
    print(json.dumps(cur, ensure_ascii=False))
else:
    print(cur)
