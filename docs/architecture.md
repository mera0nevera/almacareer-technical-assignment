# LMC Infrastructure — Linux Server Administration Assignment

End-to-end automation: a load-balanced PHP application on AWS EC2.
Infrastructure provisioned with **AWS CDK** (TypeScript), servers configured
with **Ansible** over **AWS Systems Manager** (no SSH keys, no public IPs).

## Architecture overview

```
                ┌──────────────────────────────────────┐
   Internet ──▶ │  HAProxy   10.0.1.10                 │  ◀──  :8404/stats (admin)
                │  lmc-haproxy                         │
                │                                      │
                │  frontend  mywebapp   :80            │
                │     ├─ /health  → backend health_be  │ round-robin, no stickiness
                │     └─  *       → backend webservers │ round-robin + cookie SRV
                └─────────────────┬────────────────────┘
                                  │ 80
              ┌───────────────────┼───────────────────┐
              ▼                                       ▼
   ┌──────────────────────┐                ┌──────────────────────┐
   │ Web01 10.0.1.11:80   │                │ Web02 10.0.1.12:80   │
   │ lmc-web01            │                │ lmc-web02            │
   │ Nginx + PHP-FPM      │                │ Nginx + PHP-FPM      │
   └──────────┬───────────┘                └──────────┬───────────┘
              │                                        │
              └────────────────────┬───────────────────┘
                                   ▼ 3306 (only from web IPs)
                ┌──────────────────────────┐
                │  DB        10.0.1.20     │
                │  lmc-db    MariaDB 10.5  │
                └──────────────────────────┘
```

All four EC2 instances live in a single **private** subnet (`10.0.1.0/24`)
inside `VPC 10.0.0.0/16`. No public IPs are attached to any host. Egress goes
through a NAT Gateway in the public subnet; admin access goes through SSM
Session Manager (browser, CLI, or port-forward). An S3 gateway endpoint is
attached to the VPC so the Ansible SSM connection plugin can transfer modules
to instances without paying NAT data-processing charges.

## IP plan & service inventory

| Role     | Hostname    | Private IP   | Open ports (firewalld)              | Main services             |
|----------|-------------|--------------|-------------------------------------|---------------------------|
| haproxy  | lmc-haproxy | 10.0.1.10    | 22 (SSM), 80 (any), 8404 (any)      | haproxy, rsyslog, chrony  |
| web01    | lmc-web01   | 10.0.1.11    | 22 (SSM), 80 (haproxy IP only)      | nginx, php-fpm, chrony    |
| web02    | lmc-web02   | 10.0.1.12    | 22 (SSM), 80 (haproxy IP only)      | nginx, php-fpm, chrony    |
| db       | lmc-db      | 10.0.1.20    | 22 (SSM), 3306 (web IPs only)       | mariadb, chrony           |

All instances share `Project=lmc` and a `Role=<role>` tag. Ansible's dynamic
inventory plugin discovers them automatically.

## Installed services (versions)

| Server      | Service     | Version  | Listens on          |
|-------------|-------------|----------|---------------------|
| haproxy     | HAProxy     | 2.x      | 80, 8404            |
| haproxy     | rsyslog     | 8.x      | UDP 127.0.0.1:514   |
| web01/02    | Nginx       | 1.24+    | 80                  |
| web01/02    | PHP-FPM     | 8.x      | unix socket         |
| db          | MariaDB     | 10.5     | 3306                |
| all         | chrony      | 4.x      | NTP (169.254.169.123) |
| all         | firewalld   | 1.x      | —                   |

## Security model

```
Internet → HAProxy SG  : 80/tcp (HTTP), 8404/tcp (stats), 22/tcp (break-glass)
HAProxy  → Web SG      : 80/tcp
Web SG   → DB SG       : 3306/tcp
Internet → All SGs     : 22/tcp open (break-glass with the lmc-keypair private key)
```

Port 22 is open on every SG so the RSA key pair (`lmc-keypair`, private key in
SSM Parameter Store under `/ec2/keypair/<id>`) can be used as a break-glass
fallback when SSM is unavailable. The primary access path is SSM Session
Manager — close port 22 once SSM is the only access path in your environment.

Defence in depth — every host runs `firewalld` with rules that are tighter
than the security groups (haproxy IP-only for web, web IPs-only for DB).

Hardening on every node:
- Direct root SSH login disabled (`PermitRootLogin no`)
- Password authentication disabled (`PasswordAuthentication no`)
- Admin user `sysadmin` with passwordless sudo
- Day-to-day access via SSM Session Manager (audited in CloudTrail); SSH
  break-glass key is checked into SSM Parameter Store, not distributed
- Encrypted EBS root volume (GP3, AES-256, `deleteOnTermination: true`)
- IMDSv2 required (mitigates SSRF against instance metadata)
- Time synchronised via `chronyd` against AWS time service (`169.254.169.123`)
- DB password held in AWS Secrets Manager (`/lmc/db/credentials`); the
  Ansible Vault inline value is the demo fallback only

## Deployment

### Prerequisites

```bash
node --version                           # ≥ 18
npx cdk --version                        # ≥ 2.97
aws --version                            # AWS CLI v2
brew install --cask session-manager-plugin
python3 -m pip install ansible-core boto3 botocore
ansible-galaxy collection install -r ansible/collection-requirements.yml
```

### Deploy infrastructure

```bash
cd cdk
npm ci
npx cdk bootstrap                                     # one-time per account/region

# 1. One-time GitHub OIDC bootstrap (so CI can deploy without long-lived keys)
npx cdk deploy LmcGithubOidc \
  -c githubOrg=<org> -c githubRepo=<repo>
#    → copy the DeployRoleArn output to GitHub secret AWS_DEPLOY_ROLE_ARN

# 2. Application stacks
npx cdk deploy --all
```

CDK creates four CloudFormation stacks (`LmcServers` reads from `LmcNetwork`
and `LmcConfig` via stack-to-stack references; `LmcGithubOidc` is standalone):

- **LmcGithubOidc** — GitHub OIDC provider + `github-actions-lmc-deploy` IAM
  role. Trust policy locked to `repo:<org>/<repo>:<ref>`; deploy this once,
  then expose the role ARN as `AWS_DEPLOY_ROLE_ARN` in GitHub Secrets.
- **LmcNetwork** — VPC, public + private subnets, NAT gateway, security
  groups, S3 gateway endpoint
- **LmcConfig** — Secrets Manager (`/lmc/db/credentials`), SSM Parameter Store
  (`/lmc/db/host`, `/lmc/db/name`, `/lmc/db/user`, `/lmc/ansible/ssm-bucket`),
  CloudWatch log groups, the S3 bucket used by Ansible's SSM connection plugin
- **LmcServers** — 4 EC2 instances (HAProxy / Web01 / Web02 / DB), instance
  IAM roles with `AmazonSSMManagedInstanceCore` + `CloudWatchAgentServerPolicy`,
  RSA key pair `lmc-keypair` (break-glass), and cfn-init bootstrap that
  installs the CloudWatch agent configs (log group names from `LmcConfig`).
  Application-level config (haproxy.cfg, nginx app.conf, php-fpm pool) is
  owned exclusively by Ansible.

All three application stacks have `terminationProtection: true`.

### Configure servers

```bash
cd ansible
./run.sh -m ping all       # verify SSM connectivity to all 4 hosts
./run.sh main.yml          # full provisioning: common → DB → Web → HAProxy
```

Subset playbooks for targeted runs (each also runs `common` to keep the
baseline drift-free):

```bash
./run.sh db.yml                          # common + mariadb
./run.sh web.yml                         # common + nginx + php_app (serial=1)
./run.sh web.yml --tags app_code         # ship index.php / health.php only
./run.sh web.yml --tags app_config       # rotate config.php after Vault edit
./run.sh haproxy.yml                     # common + haproxy (rebuilds haproxy.cfg)
```

`run.sh` is a thin wrapper around `ansible-playbook` that pre-flights AWS
creds + the Session Manager plugin and exports the three env vars required to
make SSM work reliably on macOS 15+:

| Env var                                | Why                                       |
|----------------------------------------|-------------------------------------------|
| `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` | macOS objc fork-safety crash             |
| `NO_PROXY='*'`                          | corporate proxies break SSM WebSocket     |
| `RES_OPTIONS='inet6=0'`                 | force IPv4 in `getaddrinfo` for SSM URLs  |

### Access (SSM Session Manager — no SSH keys)

```bash
# Interactive shell on a host
ID=$(aws ec2 describe-instances --region eu-central-1 \
       --filters Name=tag:Role,Values=haproxy Name=instance-state-name,Values=running \
       --query 'Reservations[].Instances[].InstanceId' --output text)
aws ssm start-session --target "$ID"

# Port forward (the helper script lives at the repo root, not in ansible/)
./tunnel.sh                  # haproxy :80   → http://localhost:8080
./tunnel.sh stats            # haproxy :8404 → http://localhost:8404/stats
./tunnel.sh web01            # web01 :80     → http://localhost:8081
./tunnel.sh db               # db :3306      → 127.0.0.1:3306
```

## Verification (assignment Part E)

### 1 — Application reachable through HAProxy

```bash
./tunnel.sh                                 # in one terminal
curl -i http://localhost:8080/              # HTML page; alternates web01/web02 (no cookie)
curl -s http://localhost:8080/health | jq   # 200 + {status:ok, db:ok}
```

### 2 — Database isolated from unauthorised hosts

```bash
HAPROXY=$(aws ec2 describe-instances --region eu-central-1 \
  --filters Name=tag:Role,Values=haproxy Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)

# From haproxy host (NOT in DB allow-list) → BLOCKED
aws ssm send-command --instance-ids "$HAPROXY" --region eu-central-1 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["timeout 5 bash -c \"</dev/tcp/10.0.1.20/3306\" && echo OPEN || echo BLOCKED"]'

# From web01 → OPEN
WEB01=$(aws ec2 describe-instances --region eu-central-1 \
  --filters Name=tag:Role,Values=web01 Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)
aws ssm send-command --instance-ids "$WEB01" --region eu-central-1 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["timeout 5 bash -c \"</dev/tcp/10.0.1.20/3306\" && echo OPEN || echo BLOCKED"]'
```

### 3 — Web failure doesn't take the service down

```bash
# Stop nginx on web01 → site stays up via web02
aws ssm send-command --instance-ids "$WEB01" --region eu-central-1 \
  --document-name AWS-RunShellScript --parameters 'commands=["systemctl stop nginx"]'

for i in 1 2 3 4 5 6 7 8; do curl -s http://localhost:8080/health | jq -r '.checks.hostname'; done

# Restart it
aws ssm send-command --instance-ids "$WEB01" --region eu-central-1 \
  --document-name AWS-RunShellScript --parameters 'commands=["systemctl start nginx"]'
```

### 4 — Logs

| Where to look                            | What it tells you                    |
|------------------------------------------|--------------------------------------|
| HAProxy: `/var/log/haproxy/haproxy.log`  | each request, backend chosen, status |
| HAProxy: `journalctl -u haproxy`         | service startup / config errors      |
| Nginx:   `/var/log/nginx/app_access.log` | requests reaching a web node         |
| Nginx:   `/var/log/nginx/app_error.log`  | upstream PHP errors                  |
| PHP-FPM: `/var/log/php-fpm/error.log`    | DB connection failures, traces       |
| MariaDB: `/var/log/mariadb/mariadb.log`  | startup, auth failures               |
| MariaDB: `/var/log/mariadb/slow.log`     | queries > 2 s                        |

CloudWatch aggregates nginx, php-fpm, haproxy and mariadb logs into the
`/lmc/<role>/...` log groups (created by `LmcConfig` stack).

## Database details

| Item           | Value                                |
|----------------|--------------------------------------|
| Database       | `appdb`                              |
| App user       | `appuser` (granted only from web IPs) |
| App password   | `AppPass123!` (Vault-encryptable in `inventory/group_vars/web.yml`) |
| Root password  | `AppPass123!_root` (derived; demo only) |
| Authoritative password store | AWS Secrets Manager `/lmc/db/credentials` |

Tables (created by the `mariadb` Ansible role):

- `users(id, username, email, created_at)` — pre-seeded with two rows
- `visits(id, server_hostname, visited_at)` — written on every page load

## HAProxy details

| Setting              | Value                                        |
|----------------------|----------------------------------------------|
| Frontend             | `mywebapp` on `*:80`                         |
| Backend `webservers` | balance round-robin + cookie SRV (sticky)    |
| Backend `health_be`  | balance round-robin (no stickiness)          |
| Routing              | `path /health` → `health_be`; default → `webservers` |
| Health check         | `option httpchk GET /health`, expect HTTP 200 |
| Check timing         | `inter 2s fall 3 rise 2`                     |
| Stats listener       | `*:8404/stats`                               |
| Stats credentials    | `admin / lmc-stats`                          |

The split between `webservers` and `health_be` (assignment Part D's optional
bullet) lets observability tooling probe `/health` without being affected by
the cookie-based stickiness.

## Destroy the stacks

```bash
cd cdk
npx cdk destroy --all
```

Notes:
- All three application stacks (`LmcNetwork`, `LmcConfig`, `LmcServers`) have
  `terminationProtection: true`; CDK destroy will fail until you disable it
  in `bin/lmc.ts` or via `aws cloudformation update-termination-protection`.
- Stateful resources in `LmcConfig` (Secrets Manager, CloudWatch log groups)
  use `removalPolicy: RETAIN` — they survive a destroy. The Ansible SSM
  bucket uses `RemovalPolicy.DESTROY` with `autoDeleteObjects: true`.
- `LmcGithubOidc` is independent and rarely needs to be destroyed (you would
  also need to remove the GitHub secret).

## Known limitations & possible improvements

| Limitation                                              | Improvement                                                    |
|---------------------------------------------------------|----------------------------------------------------------------|
| Single AZ (NAT GW is a SPOF)                            | Multi-AZ subnets + `natGateways: 2`                            |
| HAProxy is itself a SPOF                                | NLB in front, or two HAProxy nodes + Route53 weighted record   |
| Single MariaDB instance                                 | RDS Multi-AZ — drop the `mariadb` Ansible role                 |
| HTTP only                                               | ACM cert + ALB, or terminate TLS on HAProxy via certbot        |
| `db_pass` plaintext for demo                            | `ansible-vault encrypt_string` or read from Secrets Manager at boot |
| HAProxy stats password in clear text                    | Source from Secrets Manager                                    |
| firewalld rules duplicate SG rules                      | Defence in depth is a feature; could be gated by `manage_firewall` (already supported) |
| Port 22 open to `0.0.0.0/0` on every SG                 | Once SSM is the only access path, remove the SSH ingress rule from `NetworkStack` and drop the `lmc-keypair` key pair |
| `validation.yml`'s ansible-lint runs as warn-only       | Drop the trailing `\|\| true` once lint warnings are clean      |
| No CI runs Ansible against ephemeral env                | Add a molecule + ansible-lint CI job (OIDC role is already provisioned) |
