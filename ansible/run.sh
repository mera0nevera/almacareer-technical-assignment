#!/usr/bin/env bash
# Wrapper around ansible-playbook that fixes the well-known macOS-15 + SSM gotchas.
# Usage:  ./run.sh main.yml [extra ansible args]
#         ./run.sh -m ping all          # also works for ad-hoc ansible
set -euo pipefail

# macOS 15+ ships an objc runtime that crashes on fork() unless this is set.
# Without it, the boto3 process spawned by amazon.aws.aws_ssm dies with
# "objc[xxx]: +[NSResponder initialize] may have been in progress in another thread when fork() was called."
export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES

# Some corporate proxies break SSM's WebSocket. NO_PROXY=* keeps boto3 off them.
export NO_PROXY='*'
export no_proxy='*'

# Default region for any boto3 lookup performed by the inventory plugin.
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
export AWS_REGION="${AWS_REGION:-$AWS_DEFAULT_REGION}"

# Force IPv4 in Python's getaddrinfo. Some macOS DNS configurations resolve
# *.amazonaws.com to AAAA-only records first and SSM's signed URLs reject IPv6.
export PYTHONUNBUFFERED=1
export RES_OPTIONS="${RES_OPTIONS:-} inet6=0"

# Pre-flight: AWS credentials must be valid before we hand off to Ansible.
if ! aws sts get-caller-identity --no-cli-pager >/dev/null 2>&1; then
  echo "ERROR: aws sts get-caller-identity failed. Run 'aws sso login' or set AWS_PROFILE." >&2
  exit 1
fi

# Pre-flight: Session Manager plugin is required by amazon.aws.aws_ssm.
if ! command -v session-manager-plugin >/dev/null 2>&1; then
  echo "ERROR: session-manager-plugin not installed." >&2
  echo "Install it: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html" >&2
  exit 1
fi

# If the first arg looks like an ad-hoc module flag (-m / -a / etc.), use ansible.
# Otherwise default to ansible-playbook.
if [[ "${1:-}" == -* ]]; then
  exec ansible "$@"
else
  exec ansible-playbook "$@"
fi
