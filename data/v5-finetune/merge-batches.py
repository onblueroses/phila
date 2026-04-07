#!/usr/bin/env python3
"""Merge batch*.jsonl files into already-corrected-v5.jsonl.

Normalizes speaker names to person1/person2/person3 format and validates
all records have action:silent with proper message structure.
"""

import json
import re
import sys
from pathlib import Path

DIR = Path(__file__).parent
OUTPUT = DIR / "already-corrected-v5.jsonl"


def normalize_speakers(conversation: str) -> str:
    """Replace any speaker labels with person1/person2/person3 format."""
    lines = conversation.split("\n")
    speaker_map: dict[str, str] = {}
    normalized = []

    for line in lines:
        # Match "speaker: text" pattern
        m = re.match(r"^([^:]+):\s*(.*)$", line)
        if m:
            speaker = m.group(1).strip()
            text = m.group(2)
            # Already in personN format? Keep it.
            if re.match(r"^person\d+$", speaker):
                normalized.append(line)
            else:
                if speaker not in speaker_map:
                    speaker_map[speaker] = f"person{len(speaker_map) + 1}"
                normalized.append(f"{speaker_map[speaker]}: {text}")
        else:
            normalized.append(line)

    return "\n".join(normalized)


def main():
    batch_files = sorted(DIR.glob("batch*.jsonl"))
    if not batch_files:
        print("ERROR: no batch files found", file=sys.stderr)
        sys.exit(1)

    records = []
    skipped = 0

    for path in batch_files:
        with open(path) as f:
            for i, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    msgs = rec["messages"]
                    assert len(msgs) == 3
                    assert msgs[0]["role"] == "system"
                    assert msgs[1]["role"] == "user"
                    assert msgs[2]["role"] == "assistant"

                    # Validate assistant content
                    asst = json.loads(msgs[2]["content"])
                    assert asst["action"] == "silent"

                    # Normalize speaker names in conversation
                    msgs[1]["content"] = normalize_speakers(msgs[1]["content"])

                    records.append(rec)
                except Exception as e:
                    print(f"  SKIP {path.name}:{i}: {e}", file=sys.stderr)
                    skipped += 1

    print(
        f"Merged {len(records)} records from {len(batch_files)} files ({skipped} skipped)"
    )

    with open(OUTPUT, "w") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")

    print(f"Written to {OUTPUT}")


if __name__ == "__main__":
    main()
