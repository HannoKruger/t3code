#!/usr/bin/env bash
# Steps of .github/workflows/hanno-sync.yml and hanno-pull-request-check.yml,
# kept here so they can run locally. Each command reads its inputs from the
# environment and writes results to $GITHUB_OUTPUT (or stdout when unset).
#
# The fork merges each stable upstream tag into its branch with a merge
# commit, so the fork's own commits, including carried upstream pull requests
# ("Carried-Pull-Request: <number>" trailer), are never rewritten.
set -euo pipefail

: "${FORK_BRANCH:=hanno}"
: "${GITHUB_OUTPUT:=/dev/stdout}"
: "${WORK_DIRECTORY:=${RUNNER_TEMP:-/tmp}}"

FORK_WORKFLOWS=(.github/workflows/hanno-release.yml .github/workflows/hanno-sync.yml .github/workflows/hanno-pull-request-check.yml)
# Any workflow or action file can read this repository's secrets, so upstream
# content may never add or change one. Only the fork's own commits decide what runs.
GUARDED_PATHS=(.github/workflows .github/actions .github/scripts/hanno-sync.sh)

newest_stable_tag() {
  git ls-remote --tags --refs upstream 'v*' |
    sed 's#.*refs/tags/##' |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
    sort -V | tail -n 1
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

is_upstream_automation() {
  local file="$1"
  [[ "$file" == .github/actions/* ]] ||
    { [[ "$file" == .github/workflows/* ]] && ! is_fork_workflow "$file"; }
}

# The fork deletes upstream's workflows and actions. A merge brings back the
# ones upstream added or edited since, so they are deleted again before the
# merge commit is made.
keep_upstream_automation_deleted() {
  local file
  while read -r file; do
    if is_upstream_automation "$file"; then
      git rm --quiet --force --ignore-unmatch -- "$file"
    fi
  done < <(git diff --name-only --cached HEAD -- .github/workflows .github/actions; unresolved_files)
}

merge() {
  local newest_tag
  git config rerere.enabled true
  git config rerere.autoUpdate true
  newest_tag="$(newest_stable_tag)"
  git fetch --no-tags upstream "+refs/tags/$newest_tag:refs/tags/$newest_tag"
  echo "upstream_tag=$newest_tag" >> "$GITHUB_OUTPUT"

  if git merge-base --is-ancestor "$newest_tag" HEAD; then
    echo "$FORK_BRANCH already contains $newest_tag." >&2
    return 0
  fi

  git merge --no-ff --no-commit -m "Merge upstream $newest_tag into $FORK_BRANCH" "$newest_tag" || true
  keep_upstream_automation_deleted
  if [[ -n "$(unresolved_files)" ]]; then
    unresolved_files > "$WORK_DIRECTORY/conflicts.txt"
    git merge --abort
    echo "conflict=true" >> "$GITHUB_OUTPUT"
    return 0
  fi
  git commit --quiet --no-edit
}

guarded_changes() {
  git diff --name-only "$1" "$2" -- "${GUARDED_PATHS[@]}"
}

check_fork_paths() {
  local before="$1"
  guarded_changes "$before" HEAD > "$WORK_DIRECTORY/conflicts.txt"
  if [[ -s "$WORK_DIRECTORY/conflicts.txt" ]]; then
    echo "The merge added or changed workflow files; refusing to publish." >&2
    git reset --quiet --hard "$before"
    echo "conflict=true" >> "$GITHUB_OUTPUT"
  fi
}

refuse() {
  echo "::error::$1" >&2
  return 1
}

without_upstream_automation() {
  local file
  while read -r file; do
    is_upstream_automation "$file" || echo "$file"
  done
}

# Files the fork changes relative to the upstream release it is based on.
fork_changed_files() {
  local base="$1"
  git diff --name-only "$(git merge-base "$base" "$2")" "$base"
}

# A sync pull request merges an upstream tag into the fork branch. It may only
# resolve conflicts in files the fork already changes, so everything else stays
# exactly as upstream released it.
check_sync_branch() {
  local base="$1" head="$2" tag="$3" outside_fork_files
  git rev-parse --verify --quiet "$tag^{commit}" > /dev/null ||
    refuse "Upstream tag $tag does not exist."
  git merge-base --is-ancestor "$tag" "$head" ||
    refuse "The branch does not contain $tag."
  git merge-base --is-ancestor "$base" "$head" ||
    refuse "The branch does not contain the current $FORK_BRANCH, so it would drop fork commits."
  if [[ -n "$(guarded_changes "$base" "$head")" ]]; then
    refuse "The branch changes workflow, action or sync script files: $(guarded_changes "$base" "$head" | tr '\n' ' ')"
  fi
  outside_fork_files="$(comm -23 <(git diff --name-only "$tag" "$head" | without_upstream_automation | sort) <(fork_changed_files "$base" "$tag" | sort))"
  if [[ -n "$outside_fork_files" ]]; then
    refuse "The branch differs from $tag in files the fork does not change: $(echo "$outside_fork_files" | tr '\n' ' ')"
  fi
  echo "The branch merges $tag into $FORK_BRANCH and keeps every fork commit." >&2
}

decide_release() {
  local upstream_tag="$1" upstream_version head_sha latest_fork_tag build_number=1
  upstream_version="${upstream_tag#v}"
  head_sha="$(git rev-parse HEAD)"
  latest_fork_tag="$(git tag -l "v$upstream_version-hanno.*" | sort -V | tail -n 1)"
  if [[ -n "$latest_fork_tag" ]]; then
    if git diff --quiet "$latest_fork_tag" "$head_sha" -- . ':(exclude).github'; then
      echo "$latest_fork_tag already ships everything but .github at $head_sha." >&2
      return 0
    fi
    build_number=$((${latest_fork_tag##*-hanno.} + 1))
  fi
  echo "version=$upstream_version-hanno.$build_number" >> "$GITHUB_OUTPUT"
  echo "sha=$head_sha" >> "$GITHUB_OUTPUT"
}

case "${1:-}" in
  merge) merge ;;
  check-fork-paths) check_fork_paths "$2" ;;
  check-sync-branch) check_sync_branch "$2" "$3" "$4" ;;
  decide-release) decide_release "$2" ;;
  *)
    echo "usage: $0 merge | check-fork-paths <commit-before-merge> | check-sync-branch <base> <head> <upstream-tag> | decide-release <upstream-tag>" >&2
    exit 64
    ;;
esac
