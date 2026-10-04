"""Speech as text: map an edited row back to exact words of its source line.

A row names a source line (`A12`) and lists the words of that line it keeps. Words are cut by
deleting them, so the row's tokens must be an in-order subsequence of the line's words. Case,
leading and trailing punctuation and spacing are ignored (`norm()` on both sides), and tokens
that normalise to nothing are dropped. Anything else refuses the whole edit.

Search: dynamic programming over (row token i, line word k).

- A token matches a span of line words (j..k): one word whose norm equals it (j == k), or, as a
  fallback, two adjacent words whose norms joined equal it (k == j + 1, so `andit` matches
  `and it`). Joins are tried only when single words cannot align the whole row, so a row that
  aligns word for word never picks a join.
- State best[i][k]: the best alignment of tokens 0..i in which token i's span ends at word k.
- Transition: token i's span (j, k) follows token i-1's span ending at k' < j. If k' == j - 1 the
  current run continues; otherwise a new run starts (a cut between the two kept words). The
  first token always starts a run.
- Objective, minimised: (runs, -sum of matched word indexes). Fewest cuts first; among those the
  later words, so a retake keeps its last take. Exact ties keep the later predecessor.
- The new-run case reads a prefix minimum of best[i-1] over k' <= j - 2, so each state costs
  O(1) and a row of n tokens over a line of m words costs O(n * m) time and space.

Refusals use `lib.common.fail` (structured JSON on stderr, exit 1), like the rest of the speech
pipeline: `changed_words` names the row, the first token that cannot be placed and the line's
text; `unknown_line` names a row id the transcript does not have.
"""
import re
from typing import Sequence

from lib.common import fail
from lib.speech_lines import Line, Word, norm

_ID = re.compile(r"^([A-Z]+)(\d+)$")

Cost = tuple[int, int]  # (runs, -sum of matched word indexes); smaller is better


def _spans_ending_at(tok: str, norms: Sequence[str], k: int, joins: bool):
    """Start index j of every span ending at word k that matches tok: the single word, then the join."""
    if norms[k] == tok:
        yield k
    if joins and k >= 1 and norms[k - 1] and norms[k] and norms[k - 1] + norms[k] == tok:
        yield k - 1


def _best(tokens: Sequence[str], norms: Sequence[str], joins: bool) -> list[tuple[int, int]] | None:
    """Best alignment of tokens onto words as one (j, k) span per token, or None when there is none."""
    n, m = len(tokens), len(norms)
    if n == 0:
        return []
    # best[i][k] = (cost, j, k_prev): token i spans words j..k, token i-1 ended at k_prev (-1 for i == 0)
    best: list[list[tuple[Cost, int, int] | None]] = [[None] * m for _ in range(n)]
    for i, tok in enumerate(tokens):
        # pre[k] = (cost, k') of the best state of token i-1 ending at any k' <= k, later k' on ties
        pre: list[tuple[Cost, int] | None] = [None] * m
        if i:
            run: tuple[Cost, int] | None = None
            for k in range(m):
                s = best[i - 1][k]
                if s is not None and (run is None or s[0] <= run[0]):
                    run = (s[0], k)
                pre[k] = run
        for k in range(m):
            for j in _spans_ending_at(tok, norms, k, joins):
                gain = sum(range(j, k + 1))
                if i == 0:
                    cand = ((1, -gain), j, -1)
                else:
                    cand = None
                    if j >= 2 and pre[j - 2] is not None:  # new run after a cut
                        (runs, neg), kp = pre[j - 2]
                        cand = ((runs + 1, neg - gain), j, kp)
                    if j >= 1 and best[i - 1][j - 1] is not None:  # the run continues
                        (runs, neg), _, _ = best[i - 1][j - 1]
                        cont = ((runs, neg - gain), j, j - 1)
                        if cand is None or cont[0] <= cand[0]:
                            cand = cont
                    if cand is None:
                        continue
                cur = best[i][k]
                if cur is None or cand[0] < cur[0]:
                    best[i][k] = cand
    end = None
    for k in range(m):
        s = best[n - 1][k]
        if s is not None and (end is None or s[0] <= best[n - 1][end][0]):
            end = k
    if end is None:
        return None
    spans: list[tuple[int, int]] = []
    k = end
    for i in range(n - 1, -1, -1):
        _, j, kp = best[i][k]
        spans.append((j, k))
        k = kp
    return spans[::-1]


def _match(tokens: Sequence[str], words: Sequence[Word]) -> list[tuple[int, int]] | None:
    """Single words first; two-word joins only when single words cannot align the row."""
    norms = [w.norm for w in words]
    spans = _best(tokens, norms, joins=False)
    return spans if spans is not None else _best(tokens, norms, joins=True)


def _placeable_prefix(tokens: Sequence[str], words: Sequence[Word]) -> int:
    """How many leading tokens fit in order (joins allowed). Taking each token's earliest-ending span is optimal."""
    norms = [w.norm for w in words]
    pos = 0
    for i, tok in enumerate(tokens):
        for k in range(pos, len(norms)):
            if any(j >= pos for j in _spans_ending_at(tok, norms, k, True)):
                pos = k + 1
                break
        else:
            return i
    return len(tokens)


def _kept(row_tokens: list[str]) -> list[tuple[str, str]]:
    """(raw, normalised) for each token that normalises to something."""
    return [(t, nt) for t in row_tokens if (nt := norm(t))]


def _text(words: Sequence[Word]) -> str:
    return " ".join(w.text for w in words)


def _changed(line: Line, kept: list[tuple[str, str]]):
    p = _placeable_prefix([nt for _, nt in kept], line.words)
    fail("changed_words",
         f'{line.id}: "{kept[p][0]}" is not in the line, or not in this order. '
         f'Words can only be deleted. {line.id} is: "{_text(line.words)}"')


def align(row_tokens: list[str], line: Line) -> list[int]:
    """Matched word indexes into line.words, ascending. Fails `changed_words` when the row does not align."""
    kept = _kept(row_tokens)
    spans = _match([nt for _, nt in kept], line.words)
    if spans is None:
        _changed(line, kept)
    return [x for j, k in spans for x in range(j, k + 1)]


def _neighbours(row_id: str, lines: dict[str, Line]) -> list[tuple[Line, Line]]:
    """(earlier, later) pairs of consecutive source lines that include the row's own line."""
    m = _ID.match(row_id)
    if not m:
        return []
    letter, n = m.group(1), int(m.group(2))
    me = lines[row_id]
    prev, nxt = lines.get(f"{letter}{n - 1}"), lines.get(f"{letter}{n + 1}")
    return [p for p in ((prev, me), (me, nxt)) if p[0] is not None and p[1] is not None]


def align_row(row_id: str, row_tokens: list[str], lines: dict[str, Line]) -> list[int]:
    """align() against lines[row_id]. Fails `unknown_line` for an id not in lines, and gives a
    `changed_words` refusal a hint to split the row when its words run across the row's line
    and the line before or after it."""
    if row_id not in lines:
        fail("unknown_line", f"{row_id} is not a line of this transcript. Keep the ids speech_text wrote.")
    line = lines[row_id]
    kept = _kept(row_tokens)
    norms = [nt for _, nt in kept]
    spans = _match(norms, line.words)
    if spans is not None:
        return [x for j, k in spans for x in range(j, k + 1)]
    for first, second in _neighbours(row_id, lines):
        both = _match(norms, first.words + second.words)
        if both is None:
            continue
        cut = len(first.words)
        split = next((i for i, (j, _) in enumerate(both) if j >= cut), len(both))
        if 0 < split < len(both):
            head = " ".join(t for t, _ in kept[:split])
            tail = " ".join(t for t, _ in kept[split:])
            fail("changed_words",
                 f'{row_id}: the row runs across {first.id} and {second.id}. '
                 f'Split it into two rows: {first.id} "{head}" and {second.id} "{tail}".')
    _changed(line, kept)
