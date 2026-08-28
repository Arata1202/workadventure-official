# Contributor generator

This tool updates the contributor avatar wall in the root `README.md`. It combines GitHub's contributor data with the
repository history and merged pull requests, then replaces only the content between the contributor markers.

The scoring model and generated README structure are inspired by OpenClaw's
[`update-clawtributors.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/update-clawtributors.ts), adapted to
WorkAdventure's repository layout and npm workspaces.

## Commands

Run these commands from the repository root:

```console
npm run generate-contributors
npm run test-contributors
```

The generator requires the GitHub CLI to be authenticated and a complete Git history. The automated workflow checks out
the repository with `fetch-depth: 0` before running it.

## Ranking

The contributor score is calculated as follows:

```text
base = commits * 2 + merged pull requests * 10 + sqrt(changed source lines)
tenure = 1 + (contributor age / repository age)^2 * 0.5
score = base * tenure
```

Changes under `docs/` do not contribute to the changed-line component, preventing generated documentation from
dominating the ranking. Documentation contributors still receive commit and pull-request credit.

## Identity mappings

`contributors-map.json` resolves historical commit names and email addresses to current GitHub logins. Add an entry only
when the automatic GitHub noreply-address and login matching cannot identify the contributor.

Users with GitHub's default avatar are kept in the hidden metadata block in `README.md`. This preserves the decision
across runs and avoids probing the same hidden users every week.
