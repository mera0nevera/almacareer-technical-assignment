# LMC Infrastructure

AWS infrastructure for a load-balanced PHP application: HAProxy → 2 × Nginx/PHP-FPM → MariaDB.  
Infrastructure is defined with AWS CDK (TypeScript); servers are configured with Ansible.

## Architecture

```
                ┌──────────────────────────────────────┐
   Internet ──▶ │  HAProxy   10.0.1.10                 │  ◀──  :8404/stats (admin)
                │  lmc-haproxy                         │
                │                                      │
                │  frontend  mywebapp   :80            │
                │     ├─ /health  → backend health_be  │ round-robin
                │     └─  *       → backend webservers │ round-robin + cookie SRV
                └─────────────────┬────────────────────┘
                                  │ 80
              ┌───────────────────┼───────────────────┐
              ▼                                       ▼
   ┌──────────────────────┐                ┌──────────────────────┐
   │  web01   10.0.1.11   │                │  web02   10.0.1.12   │
   │  lmc-web01           │                │  lmc-web02           │
   │  Nginx + PHP-FPM     │                │  Nginx + PHP-FPM     │
   └──────────┬───────────┘                └──────────┬───────────┘
              └────────────────────┬───────────────────┘
                                   ▼ 3306 (only from web IPs)
                ┌──────────────────────────┐
                │  db    10.0.1.20         │
                │  lmc-db  MariaDB 10.5    │
                └──────────────────────────┘
```
All four EC2 instances live in a single **private** subnet (`10.0.1.0/24`)
inside `VPC 10.0.0.0/16`. No public IPs are attached to any host. Egress goes
through a NAT Gateway in the public subnet; admin access goes through SSM
Session Manager (browser, CLI, or port-forward).

## IP plan & service inventory

| Role     | Hostname    | Private IP   | Open ports (firewalld)              | Main services             |
|----------|-------------|--------------|-------------------------------------|---------------------------|
| haproxy  | lmc-haproxy | 10.0.1.10    | 22 (SSM), 80 (any), 8404 (any)      | haproxy, rsyslog, chrony  |
| web01    | lmc-web01   | 10.0.1.11    | 22 (SSM), 80 (haproxy IP only)      | nginx, php-fpm, chrony    |
| web02    | lmc-web02   | 10.0.1.12    | 22 (SSM), 80 (haproxy IP only)      | nginx, php-fpm, chrony    |
| db       | lmc-db      | 10.0.1.20    | 22 (SSM), 3306 (web IPs only)       | mariadb, chrony           |

All instances share `Project=lmc` and a `Role=<role>` tag. Ansible's dynamic
inventory plugin discovers them automatically.

CDK deploys four CloudFormation stacks:

- **LmcGithubOidc** — one-time bootstrap: GitHub OIDC provider + `github-actions-lmc-deploy`
                       IAM role. Output the role ARN as the `AWS_DEPLOY_ROLE_ARN` GitHub secret.
- **LmcNetwork** — VPC, public + private subnets, NAT gateway, security groups,
                    S3 gateway endpoint (used by Ansible's SSM connection plugin)
- **LmcConfig**  — Secrets Manager (DB password), SSM Parameter Store
                    (DB host/name/user, Ansible SSM bucket), CloudWatch log groups,
                    S3 bucket for Ansible SSM file transfers
- **LmcServers** — 4 EC2 instances tagged `Project=lmc, Role={haproxy|web01|web02|db}`,
                    instance roles (`AmazonSSMManagedInstanceCore` +
                    `CloudWatchAgentServerPolicy`), RSA key pair `lmc-keypair`
                    (private key stored in SSM Parameter Store as a break-glass fallback)

---

## CI/CD Pipeline

### Pull Requests + pushes to `master` → `validation.yml`

Every PR and push against `master` runs three parallel checks:

| Job | What it does |
|-----|-------------|
| **TypeScript Tests** | `npx tsc --noEmit` (strict type-check) |
| **CDK Synth & Diff** | Synthesises the template; posts/updates the infrastructure diff as a PR comment |
| **Ansible Lint** | `ansible-playbook --syntax-check` + `ansible-lint --profile production` (warn-only) |

### Push to `master` → `deploy.yml`

```
changes ──► test ──► deploy-cdk ──────────────► run-ansible ──► smoke-test
                  (cdk/** changed)   (cdk deployed OR ansible/** or app/** changed)
```

| Job | Trigger | What it does |
|-----|---------|-------------|
| **Detect — what changed** | always | Flags which paths changed (`cdk/`, `ansible/`, `app/`) |
| **Verify — TypeScript tests** | always (skippable on `workflow_dispatch`) | `tsc --noEmit` — must pass before any deploy |
| **Provision — infrastructure (CDK)** | `cdk/**` changed | `cdk deploy --all --concurrency 4`; uploads `cdk-outputs.json` |
| **Configure — servers (Ansible)** | CDK deployed, or `ansible/**` / `app/**` changed, and CDK did not fail | `ansible-playbook main.yml --diff` via SSM dynamic inventory |
| **Validate — smoke test** | after Ansible | HTTP 200 on `/`, JSON `status: ok` on `/health`, both web servers respond over 8 probes |

The pipeline also supports `workflow_dispatch` with per-stage toggles
(`run_tests`, `deploy_cdk`, `run_ansible`, `smoke_test`).

All AWS access uses **OIDC** (no long-lived access keys stored in GitHub).

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `AWS_DEPLOY_ROLE_ARN` | ARN of the IAM role GitHub Actions assumes via OIDC |
| `ANSIBLE_VAULT_PASSWORD` | Password to decrypt Ansible Vault secrets (only if `db_pass` is encrypted) |

> Ansible reaches every host via SSM Session Manager; **no SSH key is needed** in CI.

### GitHub Environment

Create a GitHub Environment named **`production`** (Settings → Environments).  
Add required reviewers there if you want manual approval before each production deploy.

---

## Local Development

```bash
# Install CDK dependencies
cd cdk && npm ci

# Strict type-check (no emit)
npx tsc --noEmit

# Preview infrastructure changes against the deployed stack
npx cdk diff

# One-time GitHub OIDC bootstrap (only needed once per repo)
npx cdk deploy LmcGithubOidc -c githubOrg=<org> -c githubRepo=<repo>

# Deploy the application stacks (requires AWS credentials configured locally)
npx cdk deploy --all

# Destroy
npx cdk destroy --all
```

### Ansible

```bash
cd ansible
pip install -r requirements.txt
ansible-galaxy collection install -r collection-requirements.yml

# Verify SSM connectivity to all 4 hosts
./run.sh -m ping all

# Syntax check
ansible-playbook main.yml --syntax-check

# Full provision (no SSH key — connects via SSM)
./run.sh main.yml

# Subset playbooks
./run.sh db.yml
./run.sh web.yml --tags app_code
./run.sh haproxy.yml

```

### SSM port-forward

`tunnel.sh` lives at the repo root and opens an SSM port-forward to whichever
host you ask for — no SSH, no public IPs.

```bash
./tunnel.sh                  # haproxy :80   → http://localhost:8080
./tunnel.sh stats            # haproxy :8404 → http://localhost:8404/stats
./tunnel.sh web01            # web01   :80   → http://localhost:8081
./tunnel.sh db               # db     :3306  → 127.0.0.1:3306
```
