# worker_v1-example-reddit-engager-repo

Playbook + Playwright wrapper for the autonomous Reddit engager.

Cloned by the sibling deployment repo
([worker_v1-example-reddit-engager-worker](https://github.com/clawborrator/worker_v1-example-reddit-engager-worker))
on container boot. You don't run anything here directly — this
repo IS the agent's instructions and tools.

## What's here

```
CLAUDE.md                 — the agent's playbook (cron-driven,
                            one cycle per turn, Bash for browser
                            work + git, MCP for notification)
specialists/reddit.js     — Playwright wrapper: auth-check,
                            scroll-feed, read-post, reply
data/posted/              — audit log; one JSON file per cycle,
                            committed by the agent on every run
```

## What the agent does each cycle

Every 4 hours, the engager:

1. Verifies its Reddit cookies still log it in
2. Scrolls the personal home feed, fetches ~20 posts
3. Picks ONE post worth engaging with (or skips the cycle if
   nothing meets the bar — quiet cycles are healthy)
4. Reads the post and its top ~100 comments
5. Picks 0-3 comments where a substantive reply adds value
6. Drafts and posts each reply via Playwright, sleeping 30-60s
   between to avoid burst-posting flags
7. Commits an audit JSON to `data/posted/<timestamp>.json`
8. Notifies `@clauderemote` (or the operator-configured peer)
   with a past-tense one-sentence summary
9. Returns; cron fires the next cycle in 4 hours

## DOM target

All Playwright work runs against [old.reddit.com](https://old.reddit.com)
rather than the new web UI. Old reddit's DOM is simpler, more
stable, less anti-bot-aggressive — same posts and comments, much
less Playwright headache.

## Updating selectors

When Reddit changes the old.reddit DOM (rare but it happens),
selectors are centralized in `specialists/reddit.js` under the
`SELECTORS` object. One-line fix.

The agent's failure path includes `comment_form_not_found` as a
typed error — when a cycle reports this in `@clauderemote`, that's
the signal to inspect old.reddit, find the new selector, patch
`reddit.js`, and `git push`. The container will pick up the new
script on its next cycle without needing a rebuild (the repo is
cloned fresh into `/workspace/repo` on each `docker compose up`,
and the cron runs `git pull` implicitly via the audit-commit
flow on every cycle — see CLAUDE.md step 8).

## Audit log

Every cycle commits a record:

```json
{
  "ts": "2026-05-16T03:00:00Z",
  "post": {
    "url": "https://old.reddit.com/r/programming/comments/...",
    "title": "...",
    "subreddit": "programming"
  },
  "replies_posted": [
    {
      "target_comment_url": "...",
      "target_author": "u/...",
      "reply_url": "https://old.reddit.com/r/.../comment/...",
      "reply_text": "..."
    }
  ],
  "skip_reason": null
}
```

Skipped cycles record `{ts, skip_reason}` so the timeline is
gap-free. Grep `data/posted/` for whatever audit question
matters: "how many cycles did we skip last week", "which
subreddits did we engage on this month", "did we ever reply to
user X".

## See also

- `../worker_v1-example-reddit-engager-worker/` — the
  docker-compose deployment + README on setup (capturing cookies,
  minting a clawborrator token, GitHub PAT, etc.)
- `../worker_v1-playwright/` — the image
- `../worker_v1-example-heartbeat-repo/` — sibling example
  showing the fan-out (3 children) version of the same swarm
  pattern. Useful for comparing: heartbeat is read-only +
  fan-out; engager is read-and-write + single-body.
