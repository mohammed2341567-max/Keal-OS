#!/usr/bin/env python3
"""Generate a Supabase KEAL invite INSERT without saving the email to disk."""
from __future__ import annotations
import getpass
import hashlib


def main() -> int:
    try:
        email = getpass.getpass("Email to invite (input hidden): ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print("\nCancelled.")
        return 1
    if not email or "@" not in email or len(email) > 254 or any(ch.isspace() for ch in email):
        print("Invalid email address.")
        return 2
    digest = hashlib.sha256(email.encode("utf-8")).hexdigest()
    print("\nCopy this SQL into the Supabase SQL Editor (only the hash is included):\n")
    print("insert into public.keal_invites(email_hash)")
    print(f"values ('{digest}')")
    print("on conflict do nothing;")
    print("\nThe helper did not write the email or hash to a local file.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
