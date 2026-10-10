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

FORK_WORKFLOWS=(.github/workflows/hanno-release.yml .github/workflows/hanno-sync.yml .github/workflows/hanno-pull-request-check.yml .github/workflows/hanno-pull-request-tests.yml)
# Any workflow or action file can read this repository's secrets, so upstream
# content may never add or change one. Only the fork's own commits decide what runs.
GUARDED_PATHS=(.github/workflows .github/actions .github/scripts/hanno-sync.sh)

STABLE_TAG='^v[0-9]+\.[0-9]+\.[0-9]+$'

newest_stable_tag() {
  git ls-remote --tags --refs upstream 'v*' |
    sed 's#.*refs/tags/##' |
    grep -E "$STABLE_TAG" |
    sort -V | tail -n 1
}

# Renames are listed as a deletion plus an addition, so both paths are checked.
changed_files() {
  git diff --no-renames --name-only "$@"
}

# The newest stable upstream tag already merged into the given commit.
last_synced_tag() {
  local tag
  for tag in $(git tag -l 'v*' | grep -E "$STABLE_TAG" | sort -rV); do
    if git merge-base --is-ancestor "$tag" "$1"; then
      echo "$tag"
      return 0
    fi
  done
  return 1
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
  done < <(changed_files --cached HEAD -- .github/workflows .github/actions; unresolved_files)
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
  changed_files "$1" "$2" -- "${GUARDED_PATHS[@]}"
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

refuse_guarded_changes() {
  local changes
  changes="$(guarded_changes "$1" "$2")"
  if [[ -n "$changes" ]]; then
    refuse "$3 changes workflow, action or sync script files: $(echo "$changes" | tr '\n' ' ')"
  fi
}

without_upstream_automation() {
  local file
  while read -r file; do
    is_upstream_automation "$file" || echo "$file"
  done
}

# Files the fork changes relative to the upstream release hanno was last synced to.
fork_changed_files() {
  local base="$1" synced_tag
  synced_tag="$(last_synced_tag "$base")" || refuse "$FORK_BRANCH contains no stable upstream tag."
  changed_files "$synced_tag" "$base"
}

# A sync branch merges the newest upstream tag into the fork branch. It may only
# resolve conflicts in files the fork already changes, so everything else stays
# exactly as upstream released it.
check_sync_branch() {
  local base="$1" head="$2" tag="$3" fork_files outside_fork_files
  [[ "$tag" == "$(newest_stable_tag)" ]] ||
    refuse "$tag is not the newest stable upstream tag."
  git rev-parse --verify --quiet "$tag^{commit}" > /dev/null ||
    refuse "Upstream tag $tag does not exist."
  if git merge-base --is-ancestor "$tag" "$base"; then
    refuse "$FORK_BRANCH already contains $tag."
  fi
  git merge-base --is-ancestor "$tag" "$head" ||
    refuse "The branch does not contain $tag."
  git merge-base --is-ancestor "$base" "$head" ||
    refuse "The branch does not contain the current $FORK_BRANCH, so it would drop fork commits."
  refuse_guarded_changes "$base" "$head" "The branch"
  fork_files="$(fork_changed_files "$base")"
  outside_fork_files="$(comm -23 <(changed_files "$tag" "$head" | without_upstream_automation | sort) <(echo "$fork_files" | sort))"
  if [[ -n "$outside_fork_files" ]]; then
    refuse "The branch differs from $tag in files the fork does not change: $(echo "$outside_fork_files" | tr '\n' ' ')"
  fi
  echo "The branch merges $tag into $FORK_BRANCH and keeps every fork commit." >&2
}

# Only sync/<tag> branches may land in the fork branch through a pull request.
check_pull_request() {
  local base="$1" head="$2" head_branch="$3"
  refuse_guarded_changes "$base" "$head" "The pull request"
  [[ "$head_branch" =~ ^sync/(v[0-9]+\.[0-9]+\.[0-9]+)$ ]] ||
    refuse "Only branches named sync/<newest stable upstream tag> may merge into $FORK_BRANCH, not $head_branch."
  check_sync_branch "$base" "$head" "${BASH_REMATCH[1]}"
}

decide_release() {
  local upstream_tag="$1" upstream_version head_sha latest_fork_tag build_number=1
  upstream_version="${upstream_tag#v}"
  head_sha="$(git rev-parse HEAD)"
  latest_fork_tag="$(git tag -l "v$upstream_version-hanno.*" | sort -V | tail -n 1)"
  if [[ -n "$latest_fork_tag" ]]; then
    if git diff --quiet --no-renames "$latest_fork_tag" "$head_sha" -- . ':(exclude).github'; then
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
  check-pull-request) check_pull_request "$2" "$3" "$4" ;;
  check-pushed-paths) refuse_guarded_changes "$2" "$3" "The push" ;;
  decide-release) decide_release "$2" ;;
  *)
    echo "usage: $0 merge | check-fork-paths <commit-before-merge> | check-sync-branch <base> <head> <upstream-tag> | check-pull-request <base> <head> <head-branch> | check-pushed-paths <before> <after> | decide-release <upstream-tag>" >&2
    exit 64
    ;;
esac
