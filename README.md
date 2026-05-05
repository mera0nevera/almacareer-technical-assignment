# LMC Infrastructure

AWS infrastructure for a load-balanced PHP application: HAProxy → 2 × Nginx/PHP-FPM → MariaDB.  
Infrastructure is defined with AWS CDK (TypeScript); servers are configured with Ansible.

## Architecture

```
Internet
    │
    ▼ :80
┌──────────┐
│  haproxy │  HAProxy (round-robin, health-checked)
│ 10.0.0.10│
└────┬─────┘
  ┌──┴───────────────────┐
  ▼                      ▼
┌──────────┐        ┌──────────┐
│  web01   │        │  web02   │
│10.0.0.11 │        │10.0.0.12 │
│Nginx+FPM │        │Nginx+FPM │
└────┬─────┘        └────┬─────┘
     └──────┬────────────┘
            ▼ :3306
       ┌──────────┐
       │    db    │
       │10.0.0.20 │
       │ MariaDB  │
       └──────────┘
```

CDK deploys two CloudFormation stacks:
- **LmcNetwork** – VPC, subnet, internet gateway, security groups
- **LmcServers** – 4 EC2 instances, SSH key pair

See [docs/architecture.md](docs/architecture.md) for full architecture, verification steps, and operational details.

---

## CI/CD Pipeline

### Pull Requests → `ci.yml`

Every PR against `main` runs three parallel checks:

| Job | What it does |
|-----|-------------|
| **TypeScript Tests** | `npm test` + `tsc --noEmit` |
| **CDK Synth & Diff** | Synthesises the template; posts the infrastructure diff as a PR comment |
| **Ansible Lint** | Syntax check + `ansible-lint --profile production` |

### Push to `main` → `deploy.yml`

```
changes ──► test ──► deploy-cdk ──────────────► run-ansible ──► smoke-test
                  (cdk/** changed)   (cdk deployed OR ansible/** or app/** changed)
```

| Job | Trigger | What it does |
|-----|---------|-------------|
| **Detect Changes** | always | Flags which paths changed (`cdk/`, `ansible/`, `app/`) |
| **TypeScript Tests** | always | Same as CI — must pass before any deploy |
| **Deploy Infrastructure** | `cdk/**` changed | `cdk deploy --all`; outputs HAProxy IP |
| **Configure Servers** | CDK deployed, or `ansible/**`/`app/**` changed, and CDK did not fail | `ansible-playbook app.yml` via SSM dynamic inventory |
| **Smoke Test** | after Ansible | HTTP 200 on `/`, JSON `status: ok` on `/health`, both web servers responding |

All AWS access uses **OIDC** (no long-lived access keys stored in GitHub).

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `AWS_DEPLOY_ROLE_ARN` | ARN of the IAM role GitHub Actions assumes via OIDC |
| `ANSIBLE_SSH_PRIVATE_KEY` | PEM private key for EC2 SSH (`sysadmin` user) |
| `ANSIBLE_VAULT_PASSWORD` | Password to decrypt Ansible Vault secrets |

### GitHub Environment

Create a GitHub Environment named **`production`** (Settings → Environments).  
Add required reviewers there if you want manual approval before each production deploy.

---

## Local Development

```bash
# Install CDK dependencies
cd cdk && npm ci

# Run unit tests
npm test

# Type-check without emitting output
npx tsc --noEmit

# Preview infrastructure changes against the deployed stack
npx cdk diff

# Deploy (requires AWS credentials configured locally)
npx cdk deploy --all

# Destroy
npx cdk destroy --all
```

### Ansible

```bash
cd ansible
pip install -r requirements.txt
ansible-galaxy collection install amazon.aws ansible.posix community.mysql community.aws

# Syntax check
ansible-playbook app.yml --syntax-check -i inventory/aws_ec2.yml

# Full provision
ansible-playbook app.yml --private-key ../lmc-key.pem --diff -v
```
