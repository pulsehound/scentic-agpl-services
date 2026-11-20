#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# scentic-agpl-services — name the source of a deployment.
#
#   bash scripts/tag-deploy.sh <environment> <commit> [--push]
#
# Makes the annotated tag  deployed/<environment>/<YYYY-MM-DD>-<shortsha>  on <commit> and prints
# the address of the source at that tag:
#
#   https://github.com/pulsehound/scentic-agpl-services/tree/deployed/<environment>/<date>-<shortsha>
#
# That address is what the consumer (Scentic) puts in its source-offer constant, so that a person
# using the deployed service is pointed at exactly the source that is running — not at a branch,
# which moves.
#
# Run by hand, by whoever deploys, once per deployment and per environment. Nothing runs it
# automatically: not a build, not a test, not a hook.
#
# Rules it keeps:
#   - A deploy tag is never moved and never deleted. If the name already exists it must already
#     point at <commit>; anything else is refused. There is no --force.
#   - The tag is annotated: it records who tagged, when, the environment and the full commit.
#   - Without --push the tag is made locally only and the push command is printed. With --push that
#     one tag is pushed (never --force, never --tags). The address works once the tag is pushed.
#   - Nothing is merged anywhere. Deployments are cut from release branches; `main` is not moved by
#     a deployment and this script does not touch any branch.
#
# The date is today's, in UTC: the day the deployment was tagged.
set -euo pipefail

REPO_URL="${SOURCE_REPO_URL:-https://github.com/pulsehound/scentic-agpl-services}"
REMOTE="${SOURCE_REMOTE:-origin}"

usage() {
  echo "usage: bash scripts/tag-deploy.sh <environment> <commit> [--push]" >&2
  echo "  environment: lower-case letters, digits and hyphens, at most 40, e.g. staging, production" >&2
  echo "  commit:      the commit that was deployed, as its SHA: 7 to 40 hexadecimal digits" >&2
  exit 2
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
ENVIRONMENT="$1"
COMMITISH="$2"
PUSH="no"
if [ "$#" -eq 3 ]; then
  [ "$3" = "--push" ] || usage
  PUSH="yes"
fi

# Both arguments, and the remote's name, are checked against a strict pattern before git sees
# them, and git is told where its options end: nothing given here can be read as an option, a
# refspec or a path.
if ! [[ "$ENVIRONMENT" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; then
  echo "error: environment must be lower-case letters, digits and hyphens, starting with a letter or digit, at most 40: '$ENVIRONMENT'" >&2
  exit 2
fi
# A SHA, not a branch or tag name: what was deployed is a commit, and a name can move.
if ! [[ "$COMMITISH" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "error: commit must be a SHA of 7 to 40 hexadecimal digits (lower case): '$COMMITISH'" >&2
  exit 2
fi
if ! [[ "$REMOTE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "error: SOURCE_REMOTE must be a remote's name (letters, digits, dot, underscore, hyphen): '$REMOTE'" >&2
  exit 2
fi

git rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not inside a git repository" >&2; exit 1; }
COMMIT="$(git rev-parse --verify --quiet --end-of-options "${COMMITISH}^{commit}")" || { echo "error: '$COMMITISH' is not a commit in this repository" >&2; exit 1; }
SHORT="$(git rev-parse --short=7 --end-of-options "$COMMIT")"
TODAY="$(date -u +%Y-%m-%d)"
TAG="deployed/${ENVIRONMENT}/${TODAY}-${SHORT}"
URL="${REPO_URL}/tree/${TAG}"

# The same commit may already carry this environment's tag from an earlier day: say so, and leave
# both. Each names a deployment that happened.
EARLIER="$(git tag --points-at "$COMMIT" --list -- "deployed/${ENVIRONMENT}/*" | grep -vxF -- "$TAG" || true)"

if git rev-parse --verify --quiet --end-of-options "refs/tags/${TAG}" >/dev/null; then
  EXISTING="$(git rev-parse --verify --end-of-options "refs/tags/${TAG}^{commit}")"
  if [ "$EXISTING" != "$COMMIT" ]; then
    echo "error: ${TAG} already exists and points at ${EXISTING}, not ${COMMIT}." >&2
    echo "       A deploy tag is never moved. Nothing was changed." >&2
    exit 1
  fi
  if [ "$(git cat-file -t -- "refs/tags/${TAG}")" != "tag" ]; then
    echo "error: ${TAG} already exists but is not an annotated tag. Nothing was changed." >&2
    exit 1
  fi
  echo "already tagged: ${TAG} -> ${COMMIT}" >&2
else
  git tag --annotate \
    --message "Deployed to ${ENVIRONMENT} on ${TODAY} (UTC)" \
    --message "Commit: ${COMMIT}" \
    --message "The source of this deployment, for the AGPL-3.0 source offer. This tag is never moved or deleted." \
    -- "$TAG" "$COMMIT"
  echo "tagged: ${TAG} -> ${COMMIT}" >&2
fi

if [ -n "$EARLIER" ]; then
  echo "note: this commit also carries, for ${ENVIRONMENT}: $(echo "$EARLIER" | tr '\n' ' ')" >&2
fi

if [ "$PUSH" = "yes" ]; then
  # One ref, by its full name; refused by the remote if a different tag of this name is there.
  git push -- "$REMOTE" "refs/tags/${TAG}:refs/tags/${TAG}"
  echo "pushed to ${REMOTE}" >&2
else
  echo "not pushed. The address below works once it is:" >&2
  echo "  git push ${REMOTE} refs/tags/${TAG}:refs/tags/${TAG}" >&2
fi

# The one line on standard output: the address for the consumer's source-offer constant.
echo "$URL"
