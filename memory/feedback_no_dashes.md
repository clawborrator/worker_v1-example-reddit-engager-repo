---
name: feedback-no-dashes
description: "Avoid double hyphens (--) as well as em/en dashes in Reddit replies; use commas, semicolons, or periods instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dc5a33d9-fa5a-4a77-a4b6-b125d955d3b7
---

Do not use -- (double hyphen) as sentence punctuation in Reddit replies, in addition to the existing ban on em dashes (—) and en dashes (–).

**Why:** Operator flagged that -- reads like a dash in prose and violates the spirit of the no-dash rule even if it passes the technical validator. The reddit.js tool rejects — and –, but -- is a stylistic problem.

**How to apply:** Replace all dash-style connectors with commas, semicolons, or periods. "X -- Y" becomes "X; Y" or "X, Y" or split into two sentences.
