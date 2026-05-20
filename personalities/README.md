# Personalities

A personality is a tone profile for the reddit-engager's replies.
One markdown file per personality. The engager loads the active
one in CLAUDE.md step 7a, named by the `ENGAGER_PERSONALITY` env
var (default: `default`).

A personality changes **how a reply sounds** (register, attitude,
word choice, rhythm). It does NOT change what the engager does or
relax any of its mechanics.

## Hard rules a personality CANNOT override

These are engager mechanics, enforced by the playbook (and, for
the dash rule, by `reddit.js` itself). A personality file must
never instruct otherwise; if one does, the engager ignores that
part:

1. **3 sentences maximum** per reply. 1, 2, or 3 complete
   sentences. Never 4, never a paragraph, never a bullet list.
2. **No em dashes or en dashes.** `reddit.js` structurally
   rejects any reply containing one. Use periods, colons,
   semicolons, parentheses, commas.
3. **On-topic.** The reply addresses what the comment actually
   said.
4. **Specific.** Real information or a concrete reason, never
   vague agreement or hedging.
5. **No markdown** bullet lists, headings, or code blocks (inline
   `code` is fine).
6. **One reply per post per cycle**, follow-up cap of 4. Cadence
   and counts are not a personality concern.

A personality operates entirely inside those rails. It picks the
voice; the rails pick the shape.

## File format

```markdown
# Personality: <name>

## Tone
<One short paragraph: the voice in plain terms. Who does this
sound like? What is the attitude?>

## Lean into
- <a concrete voice trait>
- <another>
- <another>

## Avoid
- <a trait that would break character>
- <another>

## Calibration examples
Each example shows the SAME point written flat, then in this
personality. Keep every example reply within the hard rules
(<=3 sentences, no em dashes).

Flat:    "<neutral version of a reply>"
In tone: "<same point, this personality's voice>"

Flat:    "<another neutral reply>"
In tone: "<same point, this personality's voice>"
```

## Shipped personalities

- `default.md` — the long-standing engager voice: thoughtful,
  conversational, no padding. The fallback when
  `ENGAGER_PERSONALITY` is unset or names a missing file.
- `wry-veteran.md` — a drier, more experienced-engineer register.
  Worked example of a non-default tone.

Generate more with the Gemini prompts the operator keeps
out-of-band, or hand-write them to this format.

## Switching personality

Set `ENGAGER_PERSONALITY=<name>` in the worker's `.env` and
restart the container. The name is the filename without `.md`.
