---

## The essence (read this first)

- I hold enormous depth on a _single_ problem and can stay locked on it for hours or weeks - as long as it stays challenging
- Difficulty doesn't scare me off; **boredom does.** Walls make me focus harder; tedium makes me leave. Design against _tedium_, not _complexity_
- Whole territory visible when operating something I know; depth revealed gradually when learning something new
- I think visually and spatially; prefer nested structure I can drill into over flat surfaces
- Calm surface, one primary thing - not a dense dashboard
- Reversibility engineered in deeply enough that confirmations become unnecessary
- Anything I do more than once should be scriptable
- My reading capacity varies - default to scannable, bulleted text over large paragraphs

---

## Design principles

### Focus & motivation

- **Protect against boredom, not difficulty.** Don't dumb things down or add hand-holding to routine paths. Keep even easy things fast and frictionless so they never become tedious.
- Walls are fine - I lean _in_ when stuck. Don't rescue me prematurely or over-explain when something is hard.
- I use both long uninterrupted blocks and short bursts depending on the work; don't assume a single session shape.

### Memory & continuity

- **Coupled complexity: unlimited. Uncoupled complexity: shallow - and it irritates me.** Let a single problem sprawl as deep and multi-faceted as it needs. Never force me to hold several _unrelated_ tasks in flight at once.
- **Treat external state as insurance, not convenience.** I _believe_ I'll hold context in my head, and I systematically over-promise: "back in 2 hours" becomes a 3-day break, and then it's gone. Persist my working context automatically; don't rely on me to.
- Scratch notes are my native offload format. Lightweight, freeform capture beats rigid structured forms.

### Information & density

- **Operating → whole territory available. Learning → progressive disclosure.** Density preference is _mode-dependent_, not fixed.
- **Visual/spatial thinker.** Prefer diagrams, topology, and spatial layouts over walls of prose or config. A navigable tree _is_ a visual structure and works well for me.
- **Hierarchy over flat.** Nested structure I can drill into; flat surfaces overwhelm because they destroy the spatial map I'm good at building.
- **Strong landmarks required.** My spatial map is good - except in genuinely new territory, where I do get lost. Provide breadcrumbs, clear "you are here," and orientation cues, especially on first encounter.
- **Calm surface, one primary thing.** vim, not Bloomberg terminal. Keep the rest a keystroke/click away.
- I'll learn by poking. I don't need full context before acting - let me explore and learn by doing.

### Reading & text (intermittent)

- **My reading capacity fluctuates.** Some states it's fine; in others, large paragraphs are genuinely hard to parse.
- **Default to scannable.** Bullets, short chunks, clear headings - not walls of prose. Prefer bulleted UI copy, changelogs, summaries, and docs over paragraph blocks.
- Design for the low-capacity day: never make comprehension depend on reading a dense block. Lead with the scannable version; keep prose optional/expandable.

### Decisions & defaults

- **Give me a verdict on top of the tradeoffs.** "Here's the one I'd pick and why," with the trade space named explicitly underneath. Offloading a decision is valuable to me.
- **Be honest about stakes.** When it genuinely doesn't matter, say so - "these are equivalent, pick either, I'd lean X" - rather than dressing up a coin-flip as a considered verdict. Don't manufacture false confidence.
- **Go vanilla.** Sensible defaults are a relief, not a suspicion. Default to standard/stock choices. But keep every default visible and overridable - I'll rarely override, but I want the door.

### Errors & reversibility

- **Undo over confirmation.** A confirmation assumes I might be wrong; an undo trusts I'm right but leaves a door open. Prefer no confirmation + a reliable undo.
- **Engineer recoverability in so friction isn't needed.** I build soft-deletes into everything for a reason: I want YOLO _speed_ with a trailing safety net, not speed bumps. Reversibility, not "are you sure?"
- **Context changes my risk appetite.** Work: I want a safety net on irreversible actions. Personal: fast and loose - but even there I keep building nets, so default to recoverable-by-design everywhere.
- Reserve hard confirmations for the genuinely unrecoverable; if you can make it undoable instead, do that.

### Feedback

- **Explicit on success, terse in the moment, verbose on failure.** A clear checkmark that it worked (don't leave success silent) - but a checkmark, not a paragraph.
- When something breaks, give me full, verbose diagnostics. Asymmetric: quiet-but-confirmed on success, loud-and-detailed on failure.
- Instant signal preferred - exit code / checkmark speed, not a delayed report.

### Input & control

- **Pointer-friendly, not keyboard-identity.** I'm comfortable with the mouse and click-first. Don't force me into a command-palette/keyboard-only paradigm.
- **Click while exploring, shortcuts once fluent.** Support discovery by clicking, and reward mastery with shortcuts - but don't gate core functionality behind hotkeys.
- **Automate anything repeated.** I refuse to do the same thing by hand twice. Every repetitive workflow should be scriptable/automatable. This is non-negotiable even though I'm mouse-comfortable - the two coexist: pointer for one-offs, scripts for repetition.

---

## Quick rules (fast reference for an LLM)

1. Optimize against tedium, not complexity. Keep easy paths fast; let hard things stay hard.
2. Never make me juggle unrelated tasks; let one problem go arbitrarily deep.
3. Persist my context automatically.
4. Whole territory when operating; progressive disclosure when learning.
5. Nested/hierarchical, visual, with strong landmarks. Calm surface, one primary thing.
6. Verdict + tradeoffs + honest "doesn't matter" when true.
7. Vanilla defaults, all overridable.
8. Undo everywhere; skip confirmations; make actions recoverable by design.
9. Explicit-but-terse on success; verbose on failure; instant signal.
10. Click-first and mouse-friendly; shortcuts as reward; automate anything done twice.
11. Default to bulleted, scannable text; never gate comprehension behind large paragraphs.