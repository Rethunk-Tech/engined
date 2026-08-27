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

import itertools
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
# Two paragraphs in one section sharing several long phrases: one restates the
# other. A per-feature reorganisation leaves exactly this behind -- the old
# paragraph moved under the new heading with a summary line prepended, and both
# kept. Acceptance blocks are exempt: a criterion restating the body it tests is
# the criterion doing its job. That exempts a criterion duplicated inside one
# Acceptance block too, which this does not catch.
SHINGLE = 8
SHARED_MIN = 3


def _paragraphs(lines):
    """(line number, text) per prose paragraph; None marks a section boundary."""
    in_fence, exempt, buf, start = False, False, [], 0
    for i, line in enumerate(lines, 1):
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if line.startswith("#"):
            if buf:
                yield start, " ".join(buf)
                buf = []
            exempt = line.startswith("### ") and "acceptance" in line.lower()
            if not line.startswith("###"):
                yield i, None
        elif exempt:
            continue
        elif line.strip():
            if not buf:
                start = i
            buf.append(line.strip())
        elif buf:
            yield start, " ".join(buf)
            buf = []
    if buf:
        yield start, " ".join(buf)


def _restatements(lines):
    bad, section = [], []

    def flush():
        owners = {}
        for idx, (_, text) in enumerate(section):
            w = re.sub(r"[^a-z ]", " ", text.lower()).split()
            for j in range(len(w) - SHINGLE + 1):
                owners.setdefault(" ".join(w[j : j + SHINGLE]), set()).add(idx)
        shared = {}
        for who in owners.values():
            for a, b in itertools.combinations(sorted(who), 2):
                shared[(a, b)] = shared.get((a, b), 0) + 1
        for (a, b), n in shared.items():
            if n >= SHARED_MIN:
                bad.append(
                    (
                        section[b][0],
                        f"restates line {section[a][0]} ({n} shared phrases)",
                    )
                )

    for line, para in _paragraphs(lines):
        if para is None:
            flush()
            section = []
        else:
            section.append((line, para))
    flush()
    return bad


DUP_WORD = re.compile(r"\b(\w+)\s+\1\b", re.IGNORECASE)
# words that legitimately repeat
DUP_OK = {"had", "that", "the", "who"}


def _next_code(lines, i):
    for line in lines[i:]:
        if line.strip():
            return line.startswith("```")
    return False


def check(path):
    # A doc named in .gate.toml was asserted to exist by whoever added it
    # there; report that assertion failing through the same path:line:msg
    # channel every other finding uses, rather than a raw traceback that
    # reads like the tool broke instead of the input being wrong.
    try:
        with open(path) as fh:
            text = fh.read()
    except OSError as exc:
        return [(0, f"cannot read document: {exc.strerror or exc}")]
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
                bad.append(
                    (i, f"`{term}` declared absent at line {decl}, required here")
                )

    bad += _restatements(lines)

    return bad


def _selftest():
    """The exemption is the part worth guarding: without it every acceptance
    criterion restating the body it tests reads as damage."""
    body = "## E\n\nFour edge types: modules, workspace members, submodule links\nand shared external exposure so one advisory resolves to repositories.\n"
    dup = (
        body
        + "\nFour edge types: modules, workspace members, submodule links and\nshared external exposure so one advisory resolves to repositories.\n"
    )
    assert _restatements(dup.split("\n")), "restated paragraph not caught"
    assert not _restatements(body.split("\n")), "single paragraph flagged"
    exempt = (
        body
        + "\n### Acceptance\n\n- Four edge types: modules, workspace members, submodule links\n  and shared external exposure so one advisory resolves to repositories.\n"
    )
    assert not _restatements(exempt.split("\n")), "acceptance criterion flagged"
    print("selftest ok")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--selftest"]:
        _selftest()
        sys.exit(0)
    rc = 0
    for path in sys.argv[1:]:
        for line, msg in sorted(check(path)):
            print(f"{path}:{line}: {msg}")
            rc = 1
    sys.exit(rc)
