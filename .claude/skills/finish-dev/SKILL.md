---
name: finish-dev
description: Finish development on the current WorkshopHub story. Runs /sensor-and-fix, commits through /workshophub-commit, then moves the user's Jira copy card to In Review. Never pushes, and never moves the original card. Use when the user says /finish-dev or "finish dev" / "I'm done with this story".
argument-hint: "[LATC-<n>]"
disable-model-invocation: true
allowed-tools: AskUserQuestion, Bash, Read, Skill
---

# Finish dev

Sensors, then commit, then move the card to In Review. Then stop. Follow the steps in order.

## Hard rules

- **Never push** or open a PR. The user does that.
- **Only move the user's copy card**, never the original it was copied from. The copy's summary starts with `[<Name>] ` and it has a `Cloners` link ("clones LATC-<original>"). Not sure → ask.
- The only Jira write is `acli jira workitem transition --key LATC-<n> --status 'In Review'`, on a single `--key`. Never use `--jql`, `--filter` or several keys. The `cli-write-guard` hook asks the user again; that's expected.
- Commit only through `/workshophub-commit`. Never run `git commit` yourself, and never use `--no-verify`.
- Don't move the card if the commit didn't happen.

## Board columns vs statuses

The **In Review** board column maps to the status `In Review` (board 22687). Recheck with `node scripts/jira-get.mjs /rest/agile/1.0/board/22687/configuration` if a transition looks wrong.

## Steps

### 1. Check the branch and card
- `git branch --show-current`. `main` or detached → stop, suggest `/kickoff`.
- Card key: `$ARGUMENTS` if given, else `LATC-<n>` from a `latc-<n>-<slug>` branch.
- `latc-xx-<slug>` branch (tooling work, no card) → there's no Jira step. Say so, and continue with steps 2–3 only.
- No key → ask with AskUserQuestion. Don't guess.

### 2. Sensors
Run the `/sensor-and-fix` skill and follow it fully.
- Any sensor still failing at the end → stop and report. Don't commit or move the card.

### 3. Commit
Run the `/workshophub-commit` skill and follow it fully (it asks the user to confirm the message).
- Nothing to commit (already committed) → check `git log main..HEAD --oneline` is non-empty, then continue.
- User cancels or the commit fails → stop. Don't move the card.

### 4. Check the card is the user's copy
```bash
acli jira workitem view LATC-<n> --fields 'summary,status,issuelinks' --json
```
- Summary doesn't start with `[` or there's no `Cloners` link with `outwardIssue` set → it may be the original. Ask before continuing.
- Status already `In Review` → say so and skip to step 7.

### 5. Confirm the transition
List the transitions: `node scripts/jira-get.mjs /rest/api/3/issue/LATC-<n>/transitions`. Check one has `to.name` `In Review`. None → report the available ones and ask.

Then confirm with AskUserQuestion: "Move LATC-<n> (`<summary>`) from `<status>` to In Review?" Options: move, cancel.

### 6. Transition
```bash
acli jira workitem transition --key LATC-<n> --status 'In Review' --yes --json
```
Verify with `acli jira workitem view LATC-<n> --fields status --json`. Fails → show the error and ask.

If `./stories/LATC-<n>.md` exists, update its `**Status:**` line to `In Review (board column: In Review)`. That's a local file only; mention it's uncommitted.

### 7. Stop
Report: the sensor result, the commit (`git log --oneline -1`), and the card's new status. Remind the user that `git push` and opening the PR are their next steps. Then stop.
