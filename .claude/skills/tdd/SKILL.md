---
name: tdd
description: Run ONE red-green TDD slice for WorkshopHub by delegating to the project agents. test-writer writes failing tests blind to source; the navigator confirms RED; implementer makes make test green. Exactly one acceptance criterion or Operation per run, then stop. Use when the user says /tdd, "next slice", or asks to TDD an acceptance criterion.
argument-hint: "[acceptance criterion or Operation text]"
disable-model-invocation: true
---

# TDD: one slice, red → green, via agents

The user is the **navigator**. You are the orchestrator: build the packet, delegate, run the gates, and pause where told. You don't write tests or implementation yourself.

## Hard rules

- **ONE slice per run, then stop.** A slice is one acceptance criterion or one Operation. Never start the next one.
- RED tests come only from the **test-writer** agent. GREEN code comes only from the **implementer** agent. Don't write or edit tests or source yourself, not even to "help".
- Don't implement before the navigator confirms RED.
- Never weaken, skip or delete a failing test to get green.
- Commits go through `/workshophub-commit`, and only when the navigator asks.

## Steps

### 1. Get the slice from the navigator
Use `$ARGUMENTS` if given. Otherwise ask the navigator which ONE slice to implement: a story AC (paste), an Operation, or a canvas excerpt, whatever they provide.
- More than one AC/Operation, or just "implement LATC-<n>" → ask them to pick one. Don't split it up yourself and run several.
- Check that the current branch is a story branch (`git branch --show-current`, not `main`). If it is `main`, stop and suggest `/kickoff`.
- The story file in `./stories/` may be used as context, but the slice text comes from the navigator.

### 2. Build the packet
Assemble a packet both agents receive verbatim. Include whatever the navigator provided:
```
## Slice
<AC / Operation text, verbatim>

## Requirements / Entities / Approach / Structure / Norms / Safeguards
<pass through whatever the navigator gave; omit empty sections>

## Out of scope (do NOT build or test)
<do-nots from the navigator or story "Out of Scope" that touch this slice>

## Intended module paths
<if known, e.g. api/src/services/registrationService.ts, route POST /api/training-sessions/:id/registrations>
```
- Pass the navigator's content through as given. Don't strip Approach or Operations.
- Don't invent extra criteria or a whole-story suite.
- Show the packet to the navigator before delegating.

### 3. RED: delegate to test-writer
Launch the `test-writer` agent with the packet. Tell it which slice it is and that it must not read `api/src/`. When it returns, relay its report: files, test names, the module/export contract, and assumptions.

### 4. Run tests and pause for the RED check
Run `make test` yourself and show the relevant failure output: which tests fail and the first error for each.
- Then **PAUSE**: ask the navigator with AskUserQuestion to confirm the tests are RED **for the right reason**. Missing module, 404, wrong status or missing behaviour are right. Syntax errors, broken setup, or tests that already pass are wrong.
- Options: "RED confirmed, implement", "Revise tests" (send the navigator's feedback back to test-writer, then repeat step 4), "Stop".
- If new tests already pass, flag it. It usually means the behaviour exists or the test asserts nothing.

### 5. GREEN: delegate to implementer
Only after RED is confirmed, launch the `implementer` agent with:
- the same packet
- the failing test files, test names and the `make test` failure output from step 4
- a reminder: this slice only, and never modify the tests

If the implementer stops because it needs something on the AGENT_BOUNDARY list (schema change, `make reset-db`, a new dependency), take the request to the navigator. Only on a yes, resume the implementer with that approval.

### 6. Confirm green
Run `make test` yourself and show the summary.
- Green → also run `make lint` and `make format-check` and show the results.
- Not green → show the failures, and ask the navigator whether to send it back to the implementer or stop.

### 7. Stop
Report: the slice, the tests added, the files implemented, and the gate results (test/lint/format). Offer `/workshophub-commit`. **Don't start the next slice.**
