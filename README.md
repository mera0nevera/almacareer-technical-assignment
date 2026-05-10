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

CDK deploys three CloudFormation stacks:

- **LmcNetwork** — VPC, public + private subnets, NAT gateway, security groups
- **LmcConfig**  — Secrets Manager (DB password), SSM Parameter Store
                   (DB host/name/user, Ansible SSM bucket), CloudWatch log groups
- **LmcServers** — 4 EC2 instances tagged `Project=lmc, Role={haproxy|web01|web02|db}`

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
| **Configure Servers** | CDK deployed, or `ansible/**`/`app/**` changed, and CDK did not fail | `ansible-playbook main.yml` via SSM dynamic inventory |
| **Smoke Test** | after Ansible | HTTP 200 on `/`, JSON `status: ok` on `/health`, both web servers responding |

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

# Open the app in a browser via SSM port forward
./tunnel.sh                  # haproxy :80 → http://localhost:8080
```
