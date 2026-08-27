#!/usr/bin/env python3
"""Find edit damage in long design documents.

Revision drift here is self-inflicted: a decision gets cut in one section and
the sections that depended on it are not swept. The negation check is the one
that catches that; the rest catch mechanical damage from partial edits.

Not checked: prose restating an authoritative count with a different number.
That check existed while the documents carried a fleet-census table; the
censuses are gone, because no decision rested on their exact values and they
drifted every day the fleet was worked in.
"""
import re
import sys

# Only explicit declarations that something is gone. A looser pattern (any
# "no"/"not" near a backticked term) fired seven times here with nothing real
# behind it, which is worse than not checking: noise trains you to skip output.
ABSENT = re.compile(
    r"(?:there is no|and no|gets no|has no|gets none|gone)\s+`([^`]+)`"
    r"|`([^`]+)`\s+(?:is|are)\s+(?:retired|withdrawn|deleted|gone|cut)",
    re.IGNORECASE,
)
DUP_WORD = re.compile(r"\b(\w+)\s+\1\b", re.IGNORECASE)
# words that legitimately repeat
DUP_OK = {"had", "that", "the", "who"}


def _next_code(lines, i):
    for line in lines[i:]:
        if line.strip():
            return line.startswith("```")
    return False


def check(path):
    text = open(path).read()
    lines = text.split("\n")
    bad = []

    if text.count("\n```") % 2:
        bad.append((0, "odd number of code fences"))

    in_fence = False
    for i, line in enumerate(lines, 1):
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in DUP_WORD.finditer(line):
            if m.group(1).lower() not in DUP_OK:
                bad.append((i, f"duplicated word: {m.group(0)!r}"))
        # Not checked: a line opening in lower case after a finished sentence,
        # which is the other half of a partial edit. Tried, and it cannot be
        # separated from a sentence that legitimately opens with one of this
        # fleet's lower-case project names (paper-trail, sagaforge, engined).
        # The end-of-paragraph check below catches the same edit from the
        # other side.
        # a prose line ending with no terminal punctuation, followed by a blank
        # line, is a sentence that lost its tail to a partial edit
        if (
            line
            and not line.startswith(("#", "|", "-", ">", "*", "<", " ", "\t"))
            and not re.match(r"^\s*\d+\.", line)
            # trailing emphasis markers hide the terminal punctuation behind
            # them: a line closing "…anywhere.**" is a finished sentence
            and not line.rstrip().rstrip("*_").endswith((".", ":", "!", "?", "|", "`"))
            and i < len(lines)
            and not lines[i].strip()
            # an em-dash handing off to a code block is a complete thought
            and not (line.rstrip().endswith("—") and _next_code(lines, i))
        ):
            bad.append((i, f"paragraph ends mid-sentence: ...{line.strip()[-48:]!r}"))

    # a term declared absent, then still required by an acceptance criterion or
    # a numbered migration step -- the shape every unswept cut takes here
    absent = {}
    for m in ABSENT.finditer(text):
        term = m.group(1) or m.group(2)
        absent.setdefault(term, text[: m.start()].count("\n") + 1)
    section = ""
    for i, line in enumerate(lines, 1):
        if line.startswith("#"):
            section = line.lstrip("# ").lower()
        binding = section.startswith("acceptance") or re.match(r"^\d+\. ", line)
        if not binding:
            continue
        for term, decl in absent.items():
            if len(term) < 3 or i == decl:
                continue
            if f"`{term}`" in line and not ABSENT.search(line):
                bad.append((i, f"`{term}` declared absent at line {decl}, required here"))

    return bad


if __name__ == "__main__":
    rc = 0
    for path in sys.argv[1:]:
        for line, msg in sorted(check(path)):
            print(f"{path}:{line}: {msg}")
            rc = 1
    sys.exit(rc)
