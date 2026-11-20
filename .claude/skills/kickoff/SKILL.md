---
name: kickoff
description: Start work on a WorkshopHub Jira story. Reads an LATC card, creates (or reuses) the user's personal copy in In Development, saves the story to ./stories, and checks out a latc-{id}-{desc} branch. Never edits, changes or moves the original card.
argument-hint: LATC-<n>
disable-model-invocation: true
allowed-tools: AskUserQuestion, Bash, mcp__jira__getJiraIssue, mcp__jira__editJiraIssue, mcp__jira__createJiraIssue, mcp__jira__transitionJiraIssue, mcp__jira__addOrEditJiraIssueComment, mcp__jira__atlassianUserInfo, mcp__jira__searchJiraIssuesUsingJql, mcp__jira__getAccessibleAtlassianResources, mcp__jira__discover, mcp__jira__executeRead
---

# Kickoff

Start work on one LATC story, then stop. Follow the steps in order.

## Hard rules

- **NEVER edit, change, transition, comment on or otherwise write to the original card.** Every Jira write goes to the user's copy only. Before each write, check that the target key is not the original key. If it is, stop.
- `editJiraIssue` is only for the copy, never the original.
- Use AskUserQuestion for anything unclear. Don't guess card numbers, names or statuses.
- Never push, and never commit. This command ends with a checked-out branch.
- Jira site: `thoughtworks.atlassian.net` (pass it as `cloudId`). If it is rejected, call `getAccessibleAtlassianResources` once and use the returned cloudId.

## Steps

### 1. Get the card key
Take the key from `$ARGUMENTS` (e.g. `LATC-2`, `latc-2` or `2`) and write it uppercase as `LATC-<n>`.
- Missing or unparseable → ask with AskUserQuestion.

### 2. Check the git working tree
Run `git status --short`.
- Uncommitted changes → ask whether to stop, or to carry the changes onto the new branch. Don't stash or discard anything without a yes.

### 3. Read the original card
Call `getJiraIssue` with `issueIdOrKey: LATC-<n>` and `view: "evidence"`. Note the summary, issue type, status, description, acceptance criteria and labels.
- Not found → tell the user and stop.
- The card is itself a copy (summary starts with `[`, or description starts with `Copied from LATC-`) → ask whether they meant the original it was copied from.

### 4. Identify the user
Call `atlassianUserInfo` and take the display name as `<Name>`. If it is missing, ask.

### 5. Find an existing copy
Search with `searchJiraIssuesUsingJql`:
```
project = LATC AND description ~ "\"Copied from LATC-<n>\"" ORDER BY created DESC
```
Keep only results whose summary is exactly `[<Name>] <original summary>`. Exclude the original key.
- More than one match → ask which copy to use.

### 6. Confirm the Jira write
CLAUDE.md says to ask before any MCP write, so confirm with AskUserQuestion before writing. Say exactly which write will happen: "create copy `[<Name>] <summary>` and move it to In Development", "move copy LATC-<m> to In Development", or "comment on copy LATC-<m>". Options: proceed or cancel.

### 7. Copy or comment
**A. No copy exists:**
1. `createJiraIssue` with `projectKey: "LATC"`, the original's `issueType`, `summary: "[<Name>] <original summary>"`, the original's labels, and this description:
   ```
   Copied from LATC-<n> for kickoff

   <original description, unchanged>
   ```
2. Look up transitions for the **copy**: `discover` "list transitions for a Jira issue", then `executeRead` with the returned operation name and the copy's key. Pick the transition whose target status is `In Development`. None available → ask.
3. `transitionJiraIssue` on the **copy** with that `transitionId`. Confirm that the returned status is `In Development`.

**B. Copy exists and its status is not `In Development`:** run steps A.2–A.3 on the copy.

**C. Copy exists and is already in `In Development`:** don't transition anything. Add a comment to the **copy** with `addOrEditJiraIssueComment`:
```
Kickoff re-run by <Name> on <YYYY-MM-DD>. Branch: latc-<m>-<desc>.
```

From here on, `<m>` is the copy's number.

### 8. Save the story
Write `./stories/LATC-<m>.md` (create `stories/` if missing). Overwrite only after asking.
```markdown
# LATC-<m>: [<Name>] <original summary>

- **Copy of:** LATC-<n>
- **Status:** In Development
- **Type:** <issue type>
- **Jira:** https://thoughtworks.atlassian.net/browse/LATC-<m>

## Description

<original description>

## Acceptance criteria

<acceptance criteria, if they're in a separate field; otherwise omit this section>
```

### 9. Create the branch
- `<desc>`: kebab-case slug of the original summary. Use lowercase a–z, 0–9 and hyphens only, drop filler words, and keep it to 5 words or fewer (e.g. `register-for-session`).
- Branch name: `latc-<m>-<desc>`.
- Start from an up-to-date main: `git switch main && git pull --ff-only`, then `git switch -c latc-<m>-<desc>`.
- Branch already exists → ask whether to check it out or choose another name.

### 10. Stop
Run `git branch --show-current` and report:
- the original key and the copy key, plus what was done in Jira (created+moved / moved / commented)
- the story file path
- the branch name

Then stop. Don't start implementing.
