# How this fork stays current

Branch `hanno` is the default branch: upstream `pingdotgg/t3code` plus this fork's commits. `main` is an untouched
copy of upstream. Upstream is fetch-only; pushing to it is disabled in the local clone.

## The normal path: nothing to do

1. `hanno-sync.yml` runs every 6 hours, on every push to `hanno`, and by hand. It merges the newest stable upstream tag
   (`vX.Y.Z`, no pre-releases) into `hanno` with a merge commit. Fork commits are never rewritten and never force-pushed.
2. The merge deletes upstream's workflows and actions again, and refuses any upstream change to `.github/workflows`,
   `.github/actions` or `.github/scripts/hanno-sync.sh`. Only the fork's own commits decide what runs with its secrets.
3. When `hanno` changed outside `.github`, the sync publishes `<tag>-hanno.<n>` through `hanno-release.yml`: a macOS
   arm64 build signed with the fork's self-signed certificate. The GitHub environment `release` holds that certificate
   and accepts only branch `hanno`. The Mac app checks this repository's releases every 4 minutes and updates itself.

The signing certificate and its password are kept on hulk in `~/.config/t3code-fork` and as secrets of the `release`
environment.

## When the merge conflicts

1. The sync pushes and publishes nothing. Its run fails in the job `Merge conflict with <tag>`, and the run summary
   lists the conflicting files.
2. GitHub sends the finished run to plane-agent-runner (`/webhooks/github`). The runner checks the job through the GitHub
   API and files one Plane ticket per tag in project GeldBoom, "Merge upstream T3 Code <tag> into the hanno fork",
   assigned to Agent in Todo on Claude Sonnet, and starts it.
3. The agent merges the tag on branch `sync/<tag>` (exactly that name), from `origin/hanno`, resolves the conflicts,
   runs the checks, opens a pull request into `hanno` and turns on auto-merge with a merge commit.
4. Two required checks run on the pull request. `hanno-pull-request-check.yml` ("Verify pull request") runs on
   `pull_request_target`, so its definition always comes from `hanno`, with a read-only token, no secret and no
   environment. It never runs the pull request's code: it fetches the head as git data and runs `hanno`'s copy of
   `hanno-sync.sh check-pull-request`. That accepts only a branch of this repository named `sync/<tag>`, where the tag
   is the newest stable upstream tag and not yet in `hanno`, the branch contains the tag and the whole current `hanno`,
   changes no workflow, action or sync script file, and differs from the tag only in files the fork changes relative to
   the upstream tag `hanno` was last synced to. Renames count as a deletion plus an addition.
   `hanno-pull-request-tests.yml` ("Test pull request") runs the pull request's code on `pull_request`: the carried pull
   requests' tests and the web and desktop typechecks. The gate refuses any change to that file, so it cannot be weakened.
5. Auto-merge lands the pull request. That push starts the sync, which finds the tag merged and publishes the release.

## Rules on `hanno`

A repository ruleset protects `hanno`: no deletion, no force-push, changes only through a pull request merged with a
merge commit, and the checks "Verify pull request" and "Test pull request" must pass. Only the sync's deploy key
(GitHub environment `sync`) bypasses it, for its own clean merges. Since only `sync/<tag>` pull requests pass the gate,
changing the fork's own commits or workflows means turning the ruleset off (Settings, Rules), pushing, and turning it
back on. A push that changes workflow files publishes nothing from its own sync run.

## Carried upstream pull requests

An upstream pull request the fork wants before upstream releases it is committed to `hanno` as a normal commit with the
trailer `Carried-Pull-Request: <number>`. Once upstream releases it, the merge usually conflicts on those files, and
the agent takes upstream's version.

## Running the steps locally

`.github/scripts/hanno-sync.sh` holds every step: `merge`, `check-fork-paths`, `check-sync-branch` and
`decide-release`. Each reads its inputs from the environment, so it runs against any clone with an `upstream` remote.
