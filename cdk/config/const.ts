import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';

// ── Region / AZ ───────────────────────────────────────────────────────────
// Specified explicitly so CDK does not need ec2:DescribeAvailabilityZones at synth time.
// Change both if you target a different region.
export const AVAILABILITY_ZONE = 'eu-central-1a';

// ── Network ───────────────────────────────────────────────────────────────
export const VPC_CIDR = '10.0.0.0/16';

export const PORTS = {
  http:         80,
  ssh:          22,
  mysql:        3306,
  haproxyStats: 8404,
} as const;

// These must fall inside the private subnet CIDR. CDK assigns subnet CIDRs in
// declaration order from VPC_CIDR: public=10.0.0.0/24, private=10.0.1.0/24.
export const IPS = {
  haproxy: '10.0.1.10',
  web01:   '10.0.1.11',
  web02:   '10.0.1.12',
  db:      '10.0.1.20',
} as const;

// ── Compute ───────────────────────────────────────────────────────────────
export const EC2_CONFIG = {
  keyPairName:   'lmc-keypair',
  instanceClass: ec2.InstanceClass.T3,
  instanceSize:  ec2.InstanceSize.MICRO,
} as const;

// ── Timeouts ──────────────────────────────────────────────────────────────
export const TIMEOUTS = {
  cfnInit:        cdk.Duration.minutes(10),
  oidcSession:    cdk.Duration.hours(2),
  cfnHupInterval: 15,   // minutes; written into cfn-hup.conf interval=N
} as const;

// ── SSM Parameter paths ───────────────────────────────────────────────────
export const SSM_PATHS = {
  dbHost:          '/lmc/db/host',
  dbName:          '/lmc/db/name',
  dbUser:          '/lmc/db/user',
  ansibleSsmBucket: '/lmc/ansible/ssm-bucket',
} as const;

// ── Secrets Manager names ─────────────────────────────────────────────────
export const SECRET_NAMES = {
  dbCredentials: '/lmc/db/credentials',
} as const;

// ── CloudWatch Logs ───────────────────────────────────────────────────────
export const LOG_GROUP_NAMES = {
  haproxy: '/lmc/haproxy',
  web:     '/lmc/web',
  db:      '/lmc/db',
} as const;

export const LOG_RETENTION = logs.RetentionDays.FIVE_DAYS;

// ── GitHub OIDC ───────────────────────────────────────────────────────────
export const GITHUB_OIDC = {
  // GitHub's OIDC thumbprint – update if GitHub rotates their cert.
  thumbprint:  '6938fd4d98bab03faadb97b34396831e3780aea1',
  defaultRef:  '*',
  defaultOrg:  'mera0nevera',
  defaultRepo: 'almacareer-technical-assignment',
} as const;

// ── Database ──────────────────────────────────────────────────────────────
export const DB = {
  name: 'appdb',
  user: 'appuser',
  // In production remove these and enable Secrets Manager automatic rotation.
  password:     'AppPass123!',
  rootPassword: 'RootPass123!',
} as const;

// ── Admin ─────────────────────────────────────────────────────────────────
export const ADMIN_USER = 'sysadmin';
