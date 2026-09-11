> For a designer (human or LLM) working on this app. Read alongside [`PRODUCT.md`](../PRODUCT.md).

> These reusable constraints apply to the greenfield replacement. `PRODUCT.md` owns its workflow: a stable Working on anchor, compact list/detail views, and manual GitHub refresh. "One primary thing" does not mean an automatically changing recommendation card.

> This is a set of **opinionated design constraints**, not a persona exercise or a diagnosis. It captures *how this user's mind works with software* so your hundred small decisions land right where the PRD is silent. Treat it as the generative ruleset; when in doubt, design toward these.

---

## The one thing to internalize

Design against **tedium, not difficulty.** This user leans *into* hard, challenging problems and can stay locked on one for hours or weeks. What loses them is boredom, friction, and clutter. So: keep easy paths instant and frictionless; never dumb down or add hand-holding to hard paths; never rescue prematurely. Complexity is welcome; tedium is the enemy.

---

## Core principles

- **One primary thing. Calm surface.** vim, not a Bloomberg terminal. One clear focus fills the screen; everything else is a keystroke/click away. A dense multi-panel dashboard is a failure state.

- **Never force juggling unrelated things.** Let a single problem go arbitrarily deep and multi-faceted - that's this user's strength. Depth on one thing = good; breadth across many unrelated things = bad.

- **Context is insurance, not convenience.** Persist working state automatically. Never rely on the user to hold it in their head or to remember to save - they systematically over-trust their own recall.

---

## Typography

- **Native system sans, no webfonts.** Use the platform's own UI stack (`BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` or equivalent). It renders instantly, has no loading flash, and looks like the OS rather than like a brand. Typeface should be invisible - the reader notices the words, not the font.

- **No decorative or personality typefaces.** Nothing geometric-quirky, nothing condensed, nothing with a "voice." If a font choice would be noticeable in a screenshot, it's wrong for this app.

- **Monospace means machine output, and only that.** Prompts, logs, raw JSON, diffs - things the user is inspecting rather than reading. Never set body copy, headings, labels, or UI chrome in mono. A typewriter aesthetic (IBM Plex Mono, JetBrains Mono, Space Mono as a *display* face) is an explicit anti-pattern: it makes prose slower to scan, which directly attacks the low-reading-capacity requirement.

- **One family.** Regular / bold / italic and that's it. Mix and match and select different weights as needed. Hierarchy comes from size, spacing, and color - not from mixing families. 

---

## Information & density

- **Mode-dependent density.** *Operating* something familiar → show the whole territory. *Learning* something new → progressive disclosure with strong landmarks. Don't pick one fixed density.

- **Visual / spatial, hierarchical.** Prefer diagrams, topology, nested structure to drill into. A navigable tree is a good visual structure. Flat surfaces overwhelm because they destroy the spatial map this user is good at building.

- **Strong landmarks.** In new territory the user *does* get lost - provide breadcrumbs, clear "you are here," orientation cues, especially on first encounter.

- **Scannable by default.** Bullets, short chunks, clear headings - not walls of prose. Reading capacity varies day to day; never make comprehension depend on parsing a dense paragraph. Lead with the scannable version; keep prose optional/expandable.

---

## Decisions, defaults, control

- **Verdict on top of the tradeoffs.** "Here's the one I'd pick and why," with the trade space named underneath. Offloading a decision is valuable. But be honest about stakes - when it's a coin-flip, say so; don't manufacture false confidence.

- **Vanilla defaults, all overridable.** Standard/stock choices are a relief, not a suspicion. Keep every default visible and changeable - the user will rarely override, but wants the door.

- **Undo over confirmation.** Prefer reliable recovery for local decisions. Do not imply local Undo reverses an external GitHub action. Copilot App owns its session-creation confirmation; never claim a launch bypasses it.

- **Click-first; shortcuts as reward.** Mouse-comfortable and click-to-discover. Support exploration by clicking; reward fluency with shortcuts; never gate core functionality behind a hotkey.

- **Reduce repeated work.** Keep repeated workflows simple and leave room for automation. The explicit manual-refresh and no-automatic-switching requirements take precedence; this principle does not authorize background discovery or a generic automation platform.

---

## Focus & interactive states

- **Kill the default offset outline.** The browser/framework default draws a halo a few pixels *away* from the element, so the control appears to grow and the layout twitches. Turn it off (`outline: none`) everywhere and replace it deliberately.

- **Flush ring, zero offset.** The focused element gets a 2px ring tight against its own border, plus a border color shift to the primary - `focus:border-primary focus:ring-2 focus:ring-primary/50`. Nothing moves, nothing reflows; the control just lights up in place. This is the house style for inputs, textareas, and selects.

- **Replacement is mandatory, not optional.** Never `outline: none` without putting a visible ring back. Focus must always be obvious - keyboard navigation is part of "shortcuts as reward."

- **Ring offset only where the element sits on a busy background.** A small offset is fine on image tiles or overlaid buttons where a flush ring would be invisible. It's the exception; default to zero.

- **States are instant and non-moving.** Hover, focus, active, and selected change color, not geometry. No scale jumps, no shifting padding, no borders appearing that weren't reserving space before.

---

## Feedback

- **Explicit-but-terse on success; verbose on failure.** A clear checkmark that it worked (don't leave success silent) - but a checkmark, not a paragraph. When something breaks, give full, verbose diagnostics.

- **Instant signal.** Exit-code / checkmark speed, not a delayed report. Never block interaction behind a spinner.

---

## Two constraints specific to this app

- **The last 10% is the hard part.** Make choosing and finishing work easy. Local Done means the action is finished even if the PR remains open. The desktop app can hand work to Copilot App, but launch is not completion. The browser prototype simulates that boundary.

- **Every system has a half-life.** What works fades over time. Don't design a "solve it once" system; expect to rotate and refresh. Make decay *visible in context* rather than pretending the system self-heals or handing the user a maintenance chore list.

---

## Anti-patterns (do NOT do these)

The user has ADHD, but that is **not** license for the usual clichés - most of them actively backfire here:

- ❌ **Gamification / dopamine mechanics** - streaks, badges, XP, progress bars as motivation. They become their own chore.

- ❌ **Blocking spinners and confirmation dialogs** - kill flow and imply the user is wrong.

- ❌ **Rigid structured forms** where freeform scratch would do - lightweight capture beats mandatory fields.

- ❌ **Mandatory grooming** - any taxonomy/tags/folders the user must maintain by hand will rot and become the avoidance task.

- ❌ **Personality typefaces and monospace body copy** - IBM Plex Mono as a display font, a quirky geometric sans, anything that makes the app "look designed." Mono is for machine output only.

- ❌ **Default offset focus outlines** - the halo floating a few pixels off the control, and anything else that shifts layout on interaction.

---

## Litmus test

Before shipping a surface, ask:

1. Is there **one** obvious primary thing, or does it make the user juggle?

2. Is it **scannable** on a low-reading-capacity day?

3. Are local decisions recoverable, and are external action limits explicit?

4. Does anything here quietly demand **manual upkeep**?

5. Would the **typeface** be noticeable in a screenshot? (It shouldn't be.)

6. Does anything **move** on hover or focus?