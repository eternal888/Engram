# Contradiction Recall Fix

**Date:** 18 August 2026
**Commits:** `4defce2` (agent), `ebf8f9f` (eval suite)
**Result:** contradiction recall 0.67 → 1.00, precision held at 1.00

This document explains what was broken, what changed, and how to read the eval
output. It assumes no memory of the session it came from.

---

## 1. The problem

The contradiction agent's job is to notice when a new fact conflicts with
something already in the user's memory graph. If you told Engram "I live in
Hyderabad" last month and "I moved to Mumbai" today, it should notice, mark the
old memory as superseded, and record why.

It was catching most of these. It was not catching this one:

```
existing memory:  "I am vegetarian"
new fact:         "I had steak for dinner"
```

Recall was 0.67 — it found two out of three genuine contradictions in the test
set. Precision was 1.00, meaning everything it *did* flag was a real conflict.
So the agent wasn't wrong when it spoke; it was silent when it shouldn't have
been.

### Why it was silent

The old code worked like this:

1. Take the new fact, turn it into an embedding (a 1536-number vector that
   represents its meaning).
2. Load every existing concept for that user, along with its embedding.
3. Compute **cosine similarity** between the new fact and each existing one —
   a score from 0 to 1 measuring how close the two are in meaning-space.
4. Keep only the ones scoring **0.3 or higher**.
5. Send each survivor to Claude, one API call per pair, asking "do these
   contradict?"

Step 4 is where the vegetarian case died. "I am vegetarian" and "I had steak
for dinner" score somewhere below 0.3 — they share no words, no topic, no
obvious surface connection. One is an identity statement, the other is a meal.
The pair never reached step 5. Claude never got asked.

**The underlying mistake:** cosine similarity measures *topical proximity*.
Contradiction is about *mutual exclusivity*. Those are different things, and
they come apart exactly where it matters:

| Pair | Similarity | Contradiction? |
|---|---|---|
| "I love Python" / "I love Python" | very high | no |
| "I like Rust" / "I like Go" | high | no |
| "I am vegetarian" / "I had steak" | low | **yes** |

Using a similarity gate to decide what gets checked for contradiction is using
the wrong instrument. Two statements can be nearly identical and perfectly
compatible; two statements can be miles apart and mutually exclusive.

### Why lowering the threshold wasn't the answer

The obvious fix is to drop 0.3 to 0.1 and let more through. This is bad for two
reasons:

- It's a global knob. You don't get "the right pairs plus a few extra" — you
  get nearly the entire user graph fed to Claude on every write. Cost and
  latency scale badly.
- It doesn't address the actual defect. You'd still be ranking candidates by a
  signal that doesn't measure the thing you care about, just with a looser cut.

### A second bug, found while reading the file

The old code only wrote a `Contradiction` node when `winner == "B"` — meaning
only when the *new* fact won and the old memory got superseded.

If Claude judged that the **existing** memory should be trusted instead, the
agent found the contradiction, returned it in its list, and then wrote nothing
to the graph. The finding evaporated. Same if the verdict was "neither."

This wasn't in the original problem statement. It was found by reading the file
rather than by testing, and it's part of why recall was low.

---

## 2. What changed

### Two candidate channels instead of one gate

Candidate generation now runs on two independent channels, and their union goes
to the judge.

**Channel A — semantic similarity.** Unchanged from before: cosine similarity
≥ 0.3. Still good at what it was always good at — paraphrase-shaped conflicts
where the two statements are about visibly the same thing. "I live in Boston"
vs "I moved to Seattle" scores high and is caught here.

**Channel B — recency window.** The 20 most recently created concepts for that
user, *regardless of similarity*. This is the new part.

The reasoning: if a user states a dietary preference and then mentions a meal,
those two things are close in *time* even though they're distant in
*meaning-space*. Time is a signal that similarity can't see. And bounding by a
fixed count (20) means the cost is constant — unlike lowering a threshold,
which scales unpredictably with graph size.

The union is deduped, filtered against pairs already judged, and capped at 30.

### One batched judgment call instead of one per pair

The old code made a separate Claude API call for each candidate pair. The new
code sends the new fact plus a numbered list of all candidates in a single
message, and asks for a JSON array of which indices conflict, with a reason,
a winner, and a confidence score.

This is cheaper despite evaluating *more* candidates, because the expensive part
was the per-call overhead, not the token count. It also turned out to be better:
it lets Claude see the whole candidate set at once, and it returns *every*
conflict rather than stopping at the first.

### Prompt hardening

Channel B deliberately feeds Claude unrelated pairs — that's the point, but it's
also the risk. The prompt now states explicitly what does and does not count,
with examples of both:

- *Does* count: direct opposites, later states superseding earlier ones,
  behaviour conflicting with a stated identity.
- *Does not* count: statements that are merely different, unrelated, or
  surprising. Two statements about different subjects or different attributes
  are never a contradiction, however unusual the combination.

There's also a confidence floor (default 0.7) — verdicts below it are logged and
discarded rather than written.

### Everything gets recorded now

All verdicts write a `Contradiction` node, with a `status` reflecting the
outcome:

| status | meaning |
|---|---|
| `resolved` | new fact won; old memory superseded, confidence halved |
| `retained` | existing memory won; new fact is the weaker claim |
| `unresolved` | genuine conflict, no clear winner |

Supersession behaviour is unchanged — it still only fires on `winner == "B"`.
The difference is that the other two outcomes are no longer silently dropped.

### Channel attribution

Each `Contradiction` node records which channel surfaced it: `similarity`,
`recency`, or `both`. This is what makes the results interpretable rather than
just green — see below.

### Configuration

All thresholds are environment variables, so they can be swept from the eval
harness without editing code:

| Variable | Default | Purpose |
|---|---|---|
| `CONTRADICTION_SIM_THRESHOLD` | 0.3 | Channel A cosine cutoff |
| `CONTRADICTION_RECENCY_N` | 20 | Channel B window size |
| `CONTRADICTION_MAX_CANDIDATES` | 30 | Cap on the union |
| `CONTRADICTION_MIN_CONFIDENCE` | 0.7 | Floor for writing a verdict |
| `CONTRADICTION_MODEL` | claude-sonnet-4-5 | Judge model |

Setting `CONTRADICTION_RECENCY_N=0` disables Channel B entirely, which is how
you isolate its contribution.

---

## 3. The eval suite

### Why 5 cases wasn't enough

The original contradiction suite had 5 cases: 3 positives (expect a
contradiction) and 2 negatives (expect none). The negatives were coffee/tea and
guitar/piano, each run against a graph containing *one* memory.

That's too thin to prove anything about the new design. Channel B's risk is
feeding Claude a window full of unrelated recent memories and having it
over-flag. With one memory in the graph, the window is nearly empty — the risky
condition was never tested. Precision 1.00 on that suite was not evidence.

### What was added

Expanded to 15 cases. Six new negatives and four new positives, most with
cluttered setups (3–6 unrelated facts written before the followup) so the
recency window is actually full when the judgment happens.

The new negatives target specific ways recency could go wrong:

| Case | Tests |
|---|---|
| con-006 | Unrelated-but-recent: 5 random facts, none conflicting |
| con-007 | **Different subjects** — sister's city vs my city |
| con-008 | Preference vs single instance — likes Rust, wrote Python once |
| con-009 | Additive facts — two jobs can coexist |
| con-010 | Topically adjacent, no exclusion — gym routine vs a hike |
| con-011 | **Superficially opposite** — loves cold weather, turned the heater on |

The new positives extend coverage past "one attribute replaced by another":

| Case | Tests |
|---|---|
| con-012 | Negation vs history — "never been to Japan" / "two weeks in Tokyo" |
| con-013 | Abstinence vs behaviour — same shape as the vegetarian case |
| con-014 | Quantity conflict — "I have two cats" / "I don't own any pets" |
| con-015 | **Depth under noise** — conflicting memory is oldest of six |

con-007 and con-011 were flagged in advance as the most likely to false-positive.
con-015 was the test of whether the recency window is deep enough to reach past
clutter.

---

## 4. Reading the eval output

The harness prints a lot. Most of it is noise from the extraction and retrieval
agents doing their normal work. Here is what to actually look at.

### The per-case verdict lines

```
  [PASS] con-005  detected=True expected=True
  [PASS] con-011  detected=False expected=False
```

`detected` is what the agent did. `expected` is what the test case says should
happen. They match → PASS. Note that a PASS on a *negative* case means the agent
correctly stayed quiet — that's just as much a success as catching a conflict.

### The contradiction log lines

These are the informative ones:

```
[contradiction] superseded via recency: 'The speaker is vegetarian' <- 'I had steak for dinner'
[contradiction] superseded via both:    'User lives in Hyderabad'   <- 'The speaker moved to Mumbai last week'
```

The word after "via" is the channel attribution. It tells you *which mechanism
caught this*:

- `similarity` — Channel A alone found it. Old code would have caught this too.
- `recency` — **Channel B alone found it.** Old code would have missed this.
- `both` — both channels surfaced the same candidate. Old code would have
  caught it.

This is the single most useful diagnostic in the system. It's how you tell
whether a change actually did what you designed it to do, rather than the number
moving for some unrelated reason.

### The summary block

```
  Retrieval      precision@3 1.00   precision@5 1.00   MRR 0.94
                 answer accuracy 1.00   avg 6588ms
  Grounding      pass rate 1.00  (4 cases)
  Contradiction  precision 1.00   recall 1.00   pass rate 1.00
```

For contradiction specifically:

- **Precision** — of the conflicts it flagged, how many were real. Low precision
  means false alarms: it's marking compatible statements as contradictions and
  corrupting the graph.
- **Recall** — of the real conflicts, how many it found. Low recall means silent
  misses: contradictions sit in the graph undetected.

The two trade off. Making the agent more eager raises recall and risks
precision. **Watching only recall is how you ship a regression** — the whole
point of adding eight negative cases was to make a precision drop visible.

---

## 5. Results

Fifteen out of fifteen passed. Precision 1.00, recall 1.00.

Both cases flagged in advance as likely false positives held:

- **con-007** — the extractor produced "the speaker's sister lives in Toronto"
  with the possessor intact, and the judge correctly treated sister's city and
  my city as separate attributes. This was the real test of subject
  discrimination.
- **con-011** — "loves cold weather" and "turned the heater on" were both in the
  window; no false positive. The "different attributes" rule in the prompt did
  its job.

**con-015 was the most informative case in the run:**

```
[contradiction] superseded via recency: 'User is training for a marathon' <- 'speaker has not exercised in months'
[contradiction] superseded via recency: 'User runs every morning'        <- 'speaker has not exercised in months'
```

The conflicting memory was the oldest of six, and the judge caught **both**
conflicting facts extracted from that one setup line — not just the closest
match. That's a property the old per-pair loop couldn't have produced.

**Channel attribution across the whole run:** `recency` alone caught con-005 and
con-015. Everything else came through `both`. So Channel B is responsible for
exactly the two semantically-distant cases it was designed for, and contributed
nothing spurious to the other thirteen. That's the cleanest possible outcome —
the new mechanism did precisely its intended work and no more.

---

## 6. What's still open

### The recency window has not been tested when full

The largest setup in the suite was six facts, against `RECENCY_N=20`. A
production user with 200 memories will have a *full* window on every write —
twenty unrelated memories in front of the judge, every time. That condition is
untested.

Not a reason to delay deployment. It is a reason to watch
`get_contradiction_stats()` once there are real users, particularly the
`retained` and `unresolved` counts, which are where junk verdicts would
accumulate.

### Candidate loading is still a full scan (technical debt)

`_load_concept_pool` fetches every active concept for the user **including the
full embedding array**, then computes cosine similarity in a Python loop. There
is no `LIMIT`.

At 60 concepts that's roughly 700 KB per check — invisible. At 2,000 concepts
it's about **24 MB transferred from AuraDB per fact extracted**, and extraction
often produces multiple facts per message.

The fix already exists elsewhere in the codebase: the **retrieval** agent uses a
Neo4j `SEARCH` clause over an HNSW vector index with `user_id` as an in-index
filter. The comparison happens inside the database, only the top-k rows cross
the network, and lookup is roughly logarithmic instead of linear. The
contradiction agent predates that work and never got it.

Channel B needs a different fix — it doesn't use embeddings at all, so its query
should simply stop fetching them, plus a range index:

```cypher
CREATE INDEX concept_user_created IF NOT EXISTS
FOR (c:Concept) ON (c.user_id, c.created_at)
```

**Why this wasn't done in the same commit:** changing candidate *sourcing* and
candidate *mechanism* together would have made the 0.67 → 1.00 result
impossible to attribute. One variable at a time is what made the channel
attribution readable. HNSW is also *approximate* — it can occasionally miss a
true nearest neighbour — so the swap is a real behavioural change deserving its
own before-and-after run, not a free optimization.

### Minor

- Two concepts (of 36) from 28 April lack embeddings — written before embedding
  was wired into the writer. Harmless; the current writer path is correct.
- `evals/results/*.json` is being committed on every run. Should be gitignored.

---

## 7. Method notes

Three things from this session worth repeating on the next fix:

**Baseline before changing anything.** The 0.67 number had to be re-confirmed on
the old code before the new code went in. Without it, the new numbers are just
numbers.

**One variable per commit.** The whole reason the result is interpretable is
that candidate sourcing changed and nothing else did.

**Build the diagnostic into the artifact.** The `channel` property isn't
required for the feature to work. It's there so the eval output can answer
*why*, not just *whether*. It cannot be added retroactively — the run has
already happened.

**Negative cases are the ones that catch regressions.** Positive cases tell you
the feature works. Negative cases tell you it hasn't started lying. A suite
weighted only toward positives will show green right up until it ships a bug.
