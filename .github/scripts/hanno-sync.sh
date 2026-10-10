#!/usr/bin/env bash
# Steps of .github/workflows/hanno-sync.yml, kept here so they can run locally.
# Each command reads its inputs from the environment and writes results to
# $GITHUB_OUTPUT (or stdout when that is unset).
#
# Upstream pull requests are carried as ordinary commits on the fork branch,
# committed after review, with a "Carried-Pull-Request: <number>" trailer.
# Nothing is fetched from a pull request at sync time, because its author can
# push anything to it and the result would ship as a signed update.
set -euo pipefail

: "${FORK_BRANCH:=hanno}"
: "${UPSTREAM_REPOSITORY:=pingdotgg/t3code}"
: "${GITHUB_OUTPUT:=/dev/stdout}"
: "${WORK_DIRECTORY:=${RUNNER_TEMP:-/tmp}}"

FORK_WORKFLOWS=(.github/workflows/hanno-release.yml .github/workflows/hanno-sync.yml)
# Any workflow or action file can read this repository's secrets, so a rebase
# may never add or change one. Only the fork's own commits decide what runs.
GUARDED_PATHS=(.github/workflows .github/actions .github/scripts/hanno-sync.sh)

newest_stable_tag() {
  git ls-remote --tags --refs upstream 'v*' |
    sed 's#.*refs/tags/##' |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
    sort -V | tail -n 1
}

is_pull_request_merged() {
  [[ "$(gh pr view "$1" -R "$UPSTREAM_REPOSITORY" --json state --jq .state)" == "MERGED" ]]
}

carried_pull_request_of() {
  git log -1 --format='%(trailers:key=Carried-Pull-Request,valueonly)' "$1" | head -n 1
}

# Once upstream merges a carried pull request, its reviewed version can differ
# from the carried copy, so the copy is dropped instead of rebased.
merged_carried_commits() {
  local base="$1" commit pull_request
  for commit in $(git rev-list "$base..$FORK_BRANCH"); do
    pull_request="$(carried_pull_request_of "$commit")"
    if [[ -n "$pull_request" ]] && is_pull_request_merged "$pull_request"; then
      echo "$commit"
    fi
  done
}

sequence_editor_dropping() {
  local script="" commit
  for commit in "$@"; do
    script+="/^pick $(git rev-parse --short "$commit")/d;"
  done
  echo "sed -i -E '${script:-b}'"
}

unresolved_files() {
  git diff --name-only --diff-filter=U
}

is_fork_workflow() {
  local candidate="$1" workflow
  for workflow in "${FORK_WORKFLOWS[@]}"; do
    [[ "$candidate" == "$workflow" ]] && return 0
  done
  return 1
}

# The fork deletes upstream's workflows and actions. When upstream edits one,
# the rebase stops on a modify/delete conflict, which keeping it deleted solves.
keep_upstream_automation_deleted() {
  local file
  while read -r file; do
    if [[ "$file" == .github/actions/* ]] ||
      { [[ "$file" == .github/workflows/* ]] && ! is_fork_workflow "$file"; }; then
      git rm --quiet --force -- "$file"
    fi
  done < <(unresolved_files)
}

# rerere replays conflict resolutions recorded in earlier runs. A stop that
# rerere or keep_upstream_automation_deleted fully resolved continues on its
# own; anything else is a real conflict.
continue_rebase_while_resolved() {
  while [[ -d "$(git rev-parse --git-path rebase-merge)" ]]; do
    keep_upstream_automation_deleted
    if [[ -n "$(unresolved_files)" ]]; then
      return 1
    fi
    git add --all
    GIT_EDITOR=true git rebase --continue || true
  done
}

rebase() {
  local newest_tag base
  git config rerere.enabled true
  git config rerere.autoUpdate true
  newest_tag="$(newest_stable_tag)"
  git fetch --no-tags upstream "+refs/tags/$newest_tag:refs/tags/$newest_tag"
  echo "upstream_tag=$newest_tag" >> "$GITHUB_OUTPUT"

  base="$(git merge-base "$FORK_BRANCH" "$newest_tag")"
  if [[ "$base" == "$(git rev-parse "$newest_tag^{commit}")" ]]; then
    echo "$FORK_BRANCH is already based on $newest_tag." >&2
    return 0
  fi

  local -a dropped
  mapfile -t dropped < <(merged_carried_commits "$base")
  if GIT_SEQUENCE_EDITOR="$(sequence_editor_dropping "${dropped[@]}")" \
    git rebase --interactive --empty=drop --onto "$newest_tag" "$base" "$FORK_BRANCH" ||
    continue_rebase_while_resolved; then
    return 0
  fi

  unresolved_files > "$WORK_DIRECTORY/conflicts.txt"
  git rebase --abort
  echo "conflict=true" >> "$GITHUB_OUTPUT"
}

check_fork_paths() {
  local before="$1"
  git diff --name-only "$before" HEAD -- "${GUARDED_PATHS[@]}" > "$WORK_DIRECTORY/conflicts.txt"
  if [[ -s "$WORK_DIRECTORY/conflicts.txt" ]]; then
    echo "The rebase added or changed workflow files; refusing to publish." >&2
    git reset --quiet --hard "$before"
    echo "conflict=true" >> "$GITHUB_OUTPUT"
  fi
}

decide_release() {
  local upstream_tag="$1" upstream_version head_sha latest_fork_tag build_number=1
  upstream_version="${upstream_tag#v}"
  head_sha="$(git rev-parse HEAD)"
  latest_fork_tag="$(git tag -l "v$upstream_version-hanno.*" | sort -V | tail -n 1)"
  if [[ -n "$latest_fork_tag" ]]; then
    if [[ "$(git rev-parse "$latest_fork_tag^{commit}")" == "$head_sha" ]]; then
      echo "$latest_fork_tag already ships $head_sha." >&2
      return 0
    fi
    build_number=$((${latest_fork_tag##*-hanno.} + 1))
  fi
  echo "version=$upstream_version-hanno.$build_number" >> "$GITHUB_OUTPUT"
  echo "sha=$head_sha" >> "$GITHUB_OUTPUT"
}

case "${1:-}" in
  rebase) rebase ;;
  check-fork-paths) check_fork_paths "$2" ;;
  decide-release) decide_release "$2" ;;
  *)
    echo "usage: $0 rebase | check-fork-paths <commit-before-rebase> | decide-release <upstream-tag>" >&2
    exit 64
    ;;
esac
