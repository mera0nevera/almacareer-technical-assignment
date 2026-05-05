#!/bin/bash
# HAProxy bootstrap – VM1
# This script does the MINIMUM needed so Ansible can connect.
# All real configuration (HAProxy install, config, firewall) is done by Ansible.
exec > >(tee /var/log/userdata.log | logger -t userdata) 2>&1
set -euxo pipefail

# Python3 is pre-installed on Amazon Linux 2023 (required by Ansible).
# Ensure cloud-init has finished writing SSH authorized_keys before Ansible connects.
cloud-init status --wait 2>/dev/null || true

echo "Bootstrap complete – ready for Ansible"
