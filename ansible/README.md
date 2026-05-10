# LMC — Ansible

End-to-end automation for the four-VM LMC assignment (HAProxy → 2 × Web → DB)
running on AWS EC2 in a private subnet, managed entirely over **AWS Systems
Manager (SSM)** — no SSH keys, no public IPs.

---

## Topology

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

## IP plan & service inventory

| Role     | Hostname    | Private IP   | Open ports (firewalld)              | Main services                |
|----------|-------------|--------------|-------------------------------------|------------------------------|
| haproxy  | lmc-haproxy | 10.0.1.10    | 22 (SSM), 80 (any), 8404 (any)      | haproxy, rsyslog, chrony     |
| web01    | lmc-web01   | 10.0.1.11    | 22 (SSM), 80 (haproxy IP only)      | nginx, php-fpm, chrony       |
| web02    | lmc-web02   | 10.0.1.12    | 22 (SSM), 80 (haproxy IP only)      | nginx, php-fpm, chrony       |
| db       | lmc-db      | 10.0.1.20    | 22 (SSM), 3306 (web IPs only)       | mariadb, chrony              |

All four instances share `Project=lmc` and a `Role=<role>` tag. The dynamic
inventory plugin discovers them automatically.

## Layout

```
ansible/
├── README.md
├── ansible.cfg
├── requirements.txt
├── collection-requirements.yml
├── run.sh                          # wrapper: macOS env fixes + preflight checks
├── main.yml                        # full provisioning playbook
├── db.yml / web.yml / haproxy.yml  # subset playbooks
├── inventory/
│   ├── aws_ec2.yml                 # tag:Project=lmc auto-discovery + SSM
│   └── group_vars/{all,web}.yml
└── roles/
    ├── common/                     # Part A
    ├── mariadb/                    # Part B
    ├── nginx/                      # Part C — web server
    ├── php_app/                    # Part C — application
    └── haproxy/                    # Part D
```
