#!/usr/bin/env bash
# REVIEW CANDIDATE ONLY. Authorized operator on 28server performs one
# pinned base pull and one offline build. Does NOT run a container.
# NO Compose, network creation, PKI reads, socket, target, grant or restart.
set -Eeuo pipefail
umask 077
die() { printf 'DSH_RELAY_BUILD=NO_GO reason=%s\n' "$1" >&2; exit 1; }

[[ "$#" -eq 1 && "$1" == "--approved-pull-and-build" ]] ||
  die "requires_explicit_operator_flag"
[[ "$(hostname)" == "28server" ]] || die "wrong_host"
[[ "$(uname -m)" == "x86_64" ]] || die "wrong_arch"
command -v docker >/dev/null || die "docker_unavailable"
command -v git >/dev/null || die "git_unavailable"
[[ "$(git rev-parse --show-toplevel 2>/dev/null)" == "$PWD" ]] ||
  die "must_execute_from_checkout_root"
case "$(git remote get-url origin)" in
  https://github.com/OARANHA/Remote-Ops-MCP.git|git@github.com:OARANHA/Remote-Ops-MCP.git) ;;
  *) die "wrong_repository" ;;
esac
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "modified_checkout"

# Digests from operator's 2026-10-20 Docker buildx imagetools inspect.
# This is the linux/amd64 manifest, not the multi-arch index or
# the eventual final relay-image ID.
BASE="docker.io/library/node@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562"
DOCKERFILE="integrations/deepharness/Dockerfile.agent-mesh-relay.review"
[[ -f "$DOCKERFILE" ]] || die "review_dockerfile_missing"
[[ -f integrations/deepharness/agent-mesh-unix-relay-run.mjs ]] ||
  die "relay_source_missing"
! grep -Eq '^# syntax=' "$DOCKERFILE" || die "external_frontend_unpinned"
! grep -Eq '^[[:space:]]*(RUN|ADD|EXPOSE|HEALTHCHECK)[[:space:]]' "$DOCKERFILE" ||
  die "unexpected_build_dockerfile_instruction"

HEAD_SHA="$(git rev-parse HEAD)"
TAG="local/wandora-dsh-agent-mesh-relay:review-$(printf '%s' "$HEAD_SHA" | cut -c1-12)"
printf 'DSH_RELAY_PULL=PENDING base_manifest=linux/amd64\n'
docker pull --platform linux/amd64 "$BASE"
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$BASE")" == "linux/amd64" ]] ||
  die "base_platform_mismatch"
printf 'DSH_RELAY_BASE_PLATFORM=GREEN\n'

# --pull=false ensures only the locally resolved pinned base is used;
# --network=none forbids network in build instructions. The reviewed
# Dockerfile has no RUN, ADD or lifecycle/package downloads.
docker build --platform linux/amd64 --pull=false --network=none --no-cache \
  --file "$DOCKERFILE" \
  --build-arg "DSH_RELAY_NODE_BASE_IMAGE=$BASE" \
  --tag "$TAG" .

META="$(docker image inspect --format '{{.Os}}/{{.Architecture}}|{{.Config.User}}|{{json .Config.Cmd}}|{{.Id}}|{{json .Config.ExposedPorts}}' "$TAG")"
IFS='|' read -r PLATFORM USER_ID COMMAND IMAGE_ID EXPOSED <<< "$META"
[[ "$PLATFORM" == "linux/amd64" ]] || die "candidate_platform_mismatch"
[[ "$USER_ID" == "65534:65534" ]] || die "candidate_nonroot_mismatch"
[[ "$COMMAND" == '["node","/opt/wandora-dsh-relay/agent-mesh-unix-relay-run.mjs"]' ]] ||
  die "candidate_command_mismatch"
[[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die "candidate_image_id_invalid"
[[ "$EXPOSED" == "null" || "$EXPOSED" == "{}" ]] || die "candidate_exposes_ports"

printf 'DSH_RELAY_SOURCE_SHA=%s\n' "$HEAD_SHA"
printf 'DSH_RELAY_BASE_PULL=GREEN\n'
printf 'DSH_RELAY_BUILD=GREEN\n'
printf 'DSH_RELAY_IMAGE_ID=%s\n' "$IMAGE_ID"
printf 'DSH_RELAY_IMAGE_TAG=%s\n' "$TAG"
printf 'DSH_RELAY_RUNTIME=NOT_STARTED\n'
printf 'DSH_RELAY_DEPLOY=NOT_PERFORMED\n'
