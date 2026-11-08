"""Adapt and learn: the assistant gets to know each person and gets better at their work.

  (memory)       what the assistant knows about the person is no longer here: it is the one memory store,
                 knowledge/facts.py over kn_memories (the Memory page); learning from chats and work calls it
  recorder.py    "Show me how": one recorder interface over Rooks Browser (now), Rooks Desk (adapter stub until it
                 exposes a recording stream) and plain narration; events are normalised and secrets never stored
  playbooks.py   a recording plus narration becomes a parameterised playbook in plain English steps; replay finds
                 things by meaning (label, role, text), not coordinates, and hands back to the user only when stuck
  jobs.py        what kind of job the person does and when; suggestions like "You do X every Monday, want me to?"
                 and one click routines that may prepare but never send or change anything outside without an OK
  feedback.py    thumbs and the user's own edits become lessons for the playbook or memory ("Learned from your change")
  hooks.py       the few calls the rest of Workbench makes (context, after_turn, observe, guard)
  routes.py      /api/learn/*

Everything lives in this package and its own tables (adapt_*), so merging touches shared files in a handful of lines.
"""
