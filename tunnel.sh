#!/usr/bin/env bash
# SSM port-forward to a tagged LMC EC2 instance — no SSH, no public IPs.
#
# Usage:
#   ./tunnel.sh                   # haproxy :80   → localhost:8080  (default)
#   ./tunnel.sh stats             # haproxy :8404 → localhost:8404  (HAProxy stats)
#   ./tunnel.sh web01             # web01   :80   → localhost:8081
#   ./tunnel.sh web02             # web02   :80   → localhost:8082
#   ./tunnel.sh db                # db     :3306  → localhost:3306
#   ./tunnel.sh haproxy 80 9090   # custom: <role> <remote> <local>
#
# Open the URL printed at startup, then ^C to close the tunnel.
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-almacareer-technical-assignment_cdk-dev}"
AWS_REGION="${AWS_REGION:-eu-central-1}"
export AWS_PROFILE AWS_REGION

# Pre-flight
if ! command -v session-manager-plugin >/dev/null 2>&1; then
  echo "ERROR: session-manager-plugin not installed." >&2
  echo "Install: brew install --cask session-manager-plugin" >&2
  exit 1
fi
if ! aws sts get-caller-identity --no-cli-pager >/dev/null 2>&1; then
  echo "ERROR: AWS credentials invalid for profile '$AWS_PROFILE'. Run 'aws sso login --profile $AWS_PROFILE'." >&2
  exit 1
fi

# Defaults per role
case "${1:-haproxy}" in
  ""|haproxy) ROLE=haproxy; REMOTE=${2:-80};   LOCAL=${3:-8080} ;;
  stats)      ROLE=haproxy; REMOTE=${2:-8404}; LOCAL=${3:-8404} ;;
  web01)      ROLE=web01;   REMOTE=${2:-80};   LOCAL=${3:-8081} ;;
  web02)      ROLE=web02;   REMOTE=${2:-80};   LOCAL=${3:-8082} ;;
  db)         ROLE=db;      REMOTE=${2:-3306}; LOCAL=${3:-3306} ;;
  *)          ROLE=$1;      REMOTE=${2:-80};   LOCAL=${3:-8080} ;;
esac

ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Role,Values=$ROLE" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)

if [ -z "$ID" ] || [ "$ID" = "None" ]; then
  echo "ERROR: no running instance found with tag Role=$ROLE in $AWS_REGION." >&2
  exit 1
fi

cat <<EOF
── SSM port-forward ──
  role:     $ROLE
  instance: $ID
  remote:   $REMOTE
  local:    http://localhost:$LOCAL
  stats:    user 'admin' / password 'lmc-stats' (only on :8404)
  ^C to close
EOF

exec aws ssm start-session \
  --target "$ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"$REMOTE\"],\"localPortNumber\":[\"$LOCAL\"]}"
