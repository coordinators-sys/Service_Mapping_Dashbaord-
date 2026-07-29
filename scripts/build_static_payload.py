"""Build the public payload once, ahead of time, into data/public-payload.json.

Why this file exists
--------------------
The dashboard's remaining load-time cost was the SERVER: the payload cache
lives in the serverless function's process memory, so every cold container
re-fetched and re-processed everything from Kobo — ~14 seconds before the
first byte. A CDN-served static file removes that entirely: the same payload,
already built, arrives in a few hundred milliseconds from the nearest edge.

This script is run by .github/workflows/data-refresh.yml on a daily schedule
(and by hand when needed). It writes the EXACT payload the API would serve —
same builder, same classification gates, same columnar encoding — so the two
can never disagree. The API endpoint remains as the fallback and for
`?format=rows`.

Safety: the output is the PUBLIC tier. Everything in it has already passed
  - assert_publishable   (no personal data, allowlisted fields only)
  - assert_no_site_identity (no site names, codes or coordinates)
and tests/test_static_payload.py re-verifies the committed artefact in CI on
every push — including the daily data-refresh commits themselves.

    python scripts/build_static_payload.py
"""

from __future__ import annotations

import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

OUT = os.path.join(ROOT, "data", "public-payload.json")


def load_dotenv() -> None:
    """Local convenience only — CI passes credentials as environment secrets."""
    path = os.path.join(ROOT, ".env")
    if not os.path.isfile(path):
        return
    for line in io.open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def main() -> int:
    load_dotenv()
    from api.lib.build_payload import build_payload

    payload = build_payload(force_refresh=True)
    if payload.get("source") in ("error", "no-kobo-credentials"):
        # NEVER overwrite a good artefact with an empty one. A failed fetch
        # leaves yesterday's data in place; the stale banner in the client is
        # the signal that refresh has stopped, not a blank dashboard.
        print(f"refusing to write: build reported source={payload.get('source')!r}", file=sys.stderr)
        print(payload.get("error", ""), file=sys.stderr)
        return 1

    records = payload.get("records")
    count = records.get("n") if isinstance(records, dict) else len(records or [])
    if not count:
        print("refusing to write: zero records", file=sys.stderr)
        return 1

    # Compact separators: this file is fetched by every visitor.
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with io.open(OUT, "w", encoding="utf-8") as fh:
        fh.write(body)
    print(f"{count:,} records -> {os.path.relpath(OUT, ROOT)} ({len(body)/1048576:.1f} MB raw)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
