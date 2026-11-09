#!/usr/bin/env python3
# SPDX-License-Identifier: EUPL-1.2
# © 2024–2026 Thomas Kieß and contributors

"""Writes platform/admin/src/lib/server/auth/breached-passwords.txt.

Source: SecLists (MIT, see THIRD-PARTY-NOTICES.md), pinned to a commit and checked
by SHA-256, so the result can be reproduced. Only entries of at least 15 characters
are kept (the panel refuses shorter passwords anyway), in lower case, sorted. The
top-1M lists are enough: an online attacker tries the most common passwords first,
and the much larger lists would add megabytes for rare entries.
"""
import hashlib
import urllib.request
from pathlib import Path

COMMIT = "913b327317496d062bcc7cace524aaad8a693be2"
BASE = f"https://raw.githubusercontent.com/danielmiessler/SecLists/{COMMIT}/Passwords/Common-Credentials/"
SOURCES = {
    "Pwdb_top-1000000.txt": "e9a88f67aafe65496682dc374559ee714e978bee50314767494c3e37a18c9fc8",
    "xato-net-10-million-passwords-1000000.txt": "424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51",
    "100k-most-used-passwords-NCSC.txt": "c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0",
    "darkweb2017_top-10000.txt": "479f095b0dfbae07546245441f64a45b7137352617b4caf25b81ea551e67c9af",
}
MIN_LENGTH = 15
MAX_LENGTH = 256
OUT = Path(__file__).resolve().parent.parent / "platform/admin/src/lib/server/auth/breached-passwords.txt"


def fetch(name: str, expected: str) -> bytes:
    with urllib.request.urlopen(BASE + name, timeout=300) as answer:
        data = answer.read()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise SystemExit(f"{name}: SHA-256 is {actual}, expected {expected}")
    return data


def main() -> None:
    entries: set[str] = set()
    for name, expected in SOURCES.items():
        for line in fetch(name, expected).decode("utf-8", "replace").splitlines():
            word = line.strip().lower()
            # Printable ASCII only: the rest of these lists is mostly broken encoding.
            if MIN_LENGTH <= len(word) <= MAX_LENGTH and all(32 <= ord(c) < 127 for c in word):
                entries.add(word)
    OUT.write_text("".join(f"{word}\n" for word in sorted(entries)), encoding="utf-8", newline="\n")
    print(f"{OUT.name}: {len(entries)} entries, {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
