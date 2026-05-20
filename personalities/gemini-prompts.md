# Generating personalities with Gemini

Two example prompts for producing new personality files. Paste
either into Gemini (or another capable model), then save each
output as `personalities/<name>.md`, push, set
`ENGAGER_PERSONALITY` to its name, and restart the worker.

Before committing a generated personality, skim it for stray em
dashes or en dashes. Models like to emit them; a personality file
whose own calibration examples contain dashes is a bad model for
the engager. The hard rules in `README.md` apply to the examples
inside a personality file too.

---

## Prompt 1 — generate a batch of distinct personalities

```
I run an automated Reddit commenter. It posts short, substantive replies
on technical subreddits (r/PLC, r/ClaudeCode, r/programming, r/singularity).
I want to give it selectable "personalities" that change the TONE of its
replies without changing what it does.

Generate 5 distinct personality profiles. Each must be a self-contained
tone, clearly different from the others, and each must work for a
knowledgeable technical commenter (no personality that requires being
unhelpful, hostile, or off-topic).

HARD CONSTRAINTS every personality must respect (do not write a
personality that fights these):
- Replies are AT MOST 3 sentences. Often 1.
- NO em dashes or en dashes, ever. Use periods, colons, semicolons,
  parentheses, commas.
- Always on-topic and specific (real information or a concrete reason,
  never vague agreement).
- No markdown bullet lists or headings in a reply.

Output each personality in EXACTLY this markdown format:

# Personality: <short-kebab-name>

## Tone
<one short paragraph describing the voice in plain terms>

## Lean into
- <concrete voice trait>
- <concrete voice trait>
- <concrete voice trait>

## Avoid
- <trait that would break character>
- <trait that would break character>

## Calibration examples
Flat:    "<a neutral, characterless reply>"
In tone: "<the same point rewritten in this personality, <=3 sentences, no em dashes>"

Flat:    "<another neutral reply>"
In tone: "<same point in this personality, <=3 sentences, no em dashes>"

Give me all 5, each as a separate fenced code block so I can save them
as separate files.
```

---

## Prompt 2 — generate one personality from a description you supply

```
I run an automated Reddit commenter that posts short technical replies.
I want one "personality" (a tone profile) matching this description:

  <DESCRIBE THE VOICE YOU WANT, e.g. "an enthusiastic early-career
  builder who is genuinely excited about what works and quick to share
  a small concrete win" or "a precise, formal systems engineer who
  states things exactly and never overclaims">

HARD CONSTRAINTS the personality must respect:
- Replies are AT MOST 3 sentences.
- NO em dashes or en dashes. Periods, colons, semicolons, parentheses,
  commas only.
- Always on-topic and specific.
- No markdown lists or headings in a reply.

Output in EXACTLY this format (one fenced code block):

# Personality: <short-kebab-name>

## Tone
<one short paragraph>

## Lean into
- <trait>
- <trait>
- <trait>

## Avoid
- <trait>
- <trait>

## Calibration examples
Flat:    "<neutral reply>"
In tone: "<rewritten in this personality, <=3 sentences, no em dashes>"

Flat:    "<another neutral reply>"
In tone: "<rewritten, <=3 sentences, no em dashes>"
```
