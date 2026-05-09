import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { IPS, AVAILABILITY_ZONE, EC2_CONFIG, TIMEOUTS, LOG_GROUP_NAMES } from '../../config/const';

export interface ServersStackProps extends cdk.StackProps {
  vpc:       ec2.IVpc;
  haproxySg: ec2.ISecurityGroup;
  webSg:     ec2.ISecurityGroup;
  dbSg:      ec2.ISecurityGroup;
  // From ConfigStack
  dbSecret:    secretsmanager.ISecret;
  dbHostParam: ssm.IStringParameter;
  dbNameParam: ssm.IStringParameter;
  dbUserParam: ssm.IStringParameter;
  haproxyLogs:      logs.ILogGroup;
  webLogs:          logs.ILogGroup;
  dbLogs:           logs.ILogGroup;
  ansibleSsmBucket: s3.IBucket;
}

// Fixed logical IDs so cfn-hup can reference them without a chicken-and-egg problem.
const LOGICAL = {
  haproxy: 'HAProxyInstance',
  web01:   'Web01Instance',
  web02:   'Web02Instance',
  db:      'DBInstance',
} as const;

const CW_AGENT_CONFIG_PATH = '/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json';
const CW_AGENT_START_CMD   = `/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:${CW_AGENT_CONFIG_PATH} -s 2>/dev/null || true`;

// CloudWatch agent configs – infrastructure concern (log group names come from ConfigStack).
// Application log paths are set here to match what Ansible configures on each server type.
const CW_CONFIGS = {
  haproxy: {
    logs: {
      logs_collected: {
        files: {
          collect_list: [
            { file_path: '/var/log/haproxy/haproxy.log', log_group_name: LOG_GROUP_NAMES.haproxy, log_stream_name: '{instance_id}/haproxy', timezone: 'UTC' },
          ],
        },
      },
    },
  },
  web: {
    logs: {
      logs_collected: {
        files: {
          collect_list: [
            { file_path: '/var/log/nginx/app_access.log', log_group_name: LOG_GROUP_NAMES.web, log_stream_name: '{instance_id}/nginx-access', timezone: 'UTC' },
            { file_path: '/var/log/nginx/app_error.log',  log_group_name: LOG_GROUP_NAMES.web, log_stream_name: '{instance_id}/nginx-error',  timezone: 'UTC' },
            { file_path: '/var/log/php-fpm/error.log',    log_group_name: LOG_GROUP_NAMES.web, log_stream_name: '{instance_id}/php-fpm',      timezone: 'UTC' },
          ],
        },
      },
    },
  },
  db: {
    logs: {
      logs_collected: {
        files: {
          collect_list: [
            { file_path: '/var/log/mariadb/mariadb.log', log_group_name: LOG_GROUP_NAMES.db, log_stream_name: '{instance_id}/mariadb', timezone: 'UTC' },
          ],
        },
      },
    },
  },
} as const;

export class ServersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ServersStackProps) {
    super(scope, id, props);

    const { vpc, haproxySg, webSg, dbSg } = props;

    // ── SSH Key Pair ──────────────────────────────────────────────────────────
    // Private key is stored automatically in SSM Parameter Store.
    // In production: use SSM Session Manager instead and close port 22.
    const keyPair = new ec2.KeyPair(this, 'KeyPair', {
      keyPairName: EC2_CONFIG.keyPairName,
      type: ec2.KeyPairType.RSA,
    });

    const al2023        = ec2.MachineImage.latestAmazonLinux2023({ cachedInContext: false });
    const privateSubnet = { availabilityZones: [AVAILABILITY_ZONE], subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    // ── IAM Roles ─────────────────────────────────────────────────────────────
    const haproxyRole = this.buildRole('HaproxyRole', props.haproxyLogs);
    const webRole     = this.buildRole('WebRole',     props.webLogs);
    const dbRole      = this.buildRole('DbRole',      props.dbLogs);

    props.dbHostParam.grantRead(webRole);
    props.dbNameParam.grantRead(webRole);
    props.dbUserParam.grantRead(webRole);
    props.dbSecret.grantRead(webRole);
    props.dbSecret.grantRead(dbRole);

    // Ansible SSM connection plugin uses this bucket to transfer modules to instances.
    props.ansibleSsmBucket.grantReadWrite(haproxyRole);
    props.ansibleSsmBucket.grantReadWrite(webRole);
    props.ansibleSsmBucket.grantReadWrite(dbRole);

    // ── VM1 – HAProxy ─────────────────────────────────────────────────────────
    const haproxy = new ec2.Instance(this, 'HAProxy', {
      vpc,
      instanceType:     ec2.InstanceType.of(EC2_CONFIG.instanceClass, EC2_CONFIG.instanceSize),
      machineImage:     al2023,
      securityGroup:    haproxySg,
      vpcSubnets:       privateSubnet,
      keyPair,
      role:             haproxyRole,
      privateIpAddress: IPS.haproxy,
      requireImdsv2:    true,
      blockDevices:     [encryptedRoot()],
      init:             this.buildInstanceInit(LOGICAL.haproxy, CW_CONFIGS.haproxy),
      initOptions:      { embedFingerprint: false, timeout: TIMEOUTS.cfnInit },
    });
    (haproxy.node.defaultChild as ec2.CfnInstance).overrideLogicalId(LOGICAL.haproxy);
    cdk.Tags.of(haproxy).add('Role', 'haproxy');

    // ── VM2 – Web01 ───────────────────────────────────────────────────────────
    const web01 = new ec2.Instance(this, 'Web01', {
      vpc,
      instanceType:     ec2.InstanceType.of(EC2_CONFIG.instanceClass, EC2_CONFIG.instanceSize),
      machineImage:     al2023,
      securityGroup:    webSg,
      vpcSubnets:       privateSubnet,
      keyPair,
      role:             webRole,
      privateIpAddress: IPS.web01,
      requireImdsv2:    true,
      blockDevices:     [encryptedRoot()],
      init:             this.buildInstanceInit(LOGICAL.web01, CW_CONFIGS.web),
      initOptions:      { embedFingerprint: false, timeout: TIMEOUTS.cfnInit },
    });
    (web01.node.defaultChild as ec2.CfnInstance).overrideLogicalId(LOGICAL.web01);
    cdk.Tags.of(web01).add('Role', 'web01');

    // ── VM3 – Web02 ───────────────────────────────────────────────────────────
    const web02 = new ec2.Instance(this, 'Web02', {
      vpc,
      instanceType:     ec2.InstanceType.of(EC2_CONFIG.instanceClass, EC2_CONFIG.instanceSize),
      machineImage:     al2023,
      securityGroup:    webSg,
      vpcSubnets:       privateSubnet,
      keyPair,
      role:             webRole,
      privateIpAddress: IPS.web02,
      requireImdsv2:    true,
      blockDevices:     [encryptedRoot()],
      init:             this.buildInstanceInit(LOGICAL.web02, CW_CONFIGS.web),
      initOptions:      { embedFingerprint: false, timeout: TIMEOUTS.cfnInit },
    });
    (web02.node.defaultChild as ec2.CfnInstance).overrideLogicalId(LOGICAL.web02);
    cdk.Tags.of(web02).add('Role', 'web02');

    // ── VM4 – DB ──────────────────────────────────────────────────────────────
    const db = new ec2.Instance(this, 'DB', {
      vpc,
      instanceType:     ec2.InstanceType.of(EC2_CONFIG.instanceClass, EC2_CONFIG.instanceSize),
      machineImage:     al2023,
      securityGroup:    dbSg,
      vpcSubnets:       privateSubnet,
      keyPair,
      role:             dbRole,
      privateIpAddress: IPS.db,
      requireImdsv2:    true,
      blockDevices:     [encryptedRoot(20)],
      init:             this.buildInstanceInit(LOGICAL.db, CW_CONFIGS.db),
      initOptions:      { embedFingerprint: false, timeout: TIMEOUTS.cfnInit },
    });
    (db.node.defaultChild as ec2.CfnInstance).overrideLogicalId(LOGICAL.db);
    cdk.Tags.of(db).add('Role', 'db');

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SsmReloadNginx', {
      value: `aws ssm send-command --targets "Key=tag:Role,Values=web01,web02" --document-name AWS-RunShellScript --parameters commands="systemctl reload nginx"`,
      description: 'Reload Nginx on all web servers via SSM Run Command',
    });
    new cdk.CfnOutput(this, 'SsmRunHaproxyCheck', {
      value: `aws ssm send-command --targets "Key=tag:Role,Values=haproxy" --document-name AWS-RunShellScript --parameters commands="haproxy -c -f /etc/haproxy/haproxy.cfg"`,
      description: 'Validate HAProxy config via SSM',
    });
    new cdk.CfnOutput(this, 'SsmSessionWeb01', {
      value: `aws ssm start-session --target ${web01.instanceId}`,
      description: 'SSH-less shell into Web01 via SSM Session Manager',
    });
    new cdk.CfnOutput(this, 'HaproxyPrivateIp', { value: haproxy.instancePrivateIp });
    new cdk.CfnOutput(this, 'Web01PrivateIp',   { value: web01.instancePrivateIp });
    new cdk.CfnOutput(this, 'Web02PrivateIp',   { value: web02.instancePrivateIp });
    new cdk.CfnOutput(this, 'DbPrivateIp',      { value: db.instancePrivateIp });
    new cdk.CfnOutput(this, 'AppUrl',           { value: `http://${haproxy.instancePrivateIp}/` });
    new cdk.CfnOutput(this, 'SsmTunnelHaproxy', {
      value: `aws ssm start-session --target ${haproxy.instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["80"],"localPortNumber":["8080"]}' --region ${this.region}`,
      description: 'Tunnel HAProxy port 80 to localhost:8080 via SSM',
    });
    new cdk.CfnOutput(this, 'SshKeyCommand', {
      value: `aws ssm get-parameter --name /ec2/keypair/${keyPair.keyPairId} --with-decryption --query Parameter.Value --output text > lmc-key.pem && chmod 600 lmc-key.pem`,
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildCfnHupConfig(logicalId: string): ec2.InitConfig {
    return new ec2.InitConfig([
      ec2.InitFile.fromString('/etc/cfn/cfn-hup.conf',
        `[main]\nstack=${this.stackId}\nregion=${this.region}\ninterval=${TIMEOUTS.cfnHupInterval}\nverbose=false`
      ),
      ec2.InitFile.fromString('/etc/cfn/hooks.d/cfn-auto-reloader.conf', [
        '[cfn-auto-reloader-hook]',
        'triggers=post.update',
        `path=Resources.${logicalId}.Metadata.AWS::CloudFormation::Init`,
        `action=/opt/aws/bin/cfn-init --stack ${this.stackName} --resource ${logicalId} --region ${this.region} --configsets update`,
        'runas=root',
      ].join('\n')),
      ec2.InitService.enable('cfn-hup', { enabled: true, ensureRunning: true }),
    ]);
  }

  // All instance types share the same cfn-init shape: cfn-hup for live
  // metadata updates + CloudWatch agent for log shipping. Application-level
  // config (haproxy.cfg, nginx app.conf, etc.) is owned exclusively by Ansible.
  private buildInstanceInit(logicalId: string, cwAgentConfig: Record<string, unknown>): ec2.CloudFormationInit {
    return ec2.CloudFormationInit.fromConfigSets({
      configSets: {
        default: ['cfn_hup', 'observability'],
        update:  ['observability'],
      },
      configs: {
        cfn_hup: this.buildCfnHupConfig(logicalId),
        observability: new ec2.InitConfig([
          ec2.InitFile.fromObject(CW_AGENT_CONFIG_PATH, cwAgentConfig),
          ec2.InitCommand.shellCommand(CW_AGENT_START_CMD, { key: 'start-cw-agent' }),
        ]),
      },
    });
  }

  private buildRole(id: string, logGroup: logs.ILogGroup): iam.Role {
    const role = new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // cfn-init signals CloudFormation on success/failure – scoped to this stack only.
    role.addToPolicy(new iam.PolicyStatement({
      actions:   ['cloudformation:DescribeStackResource', 'cloudformation:SignalResource'],
      resources: [this.formatArn({
        service:      'cloudformation',
        resource:     'stack',
        resourceName: `${this.stackName}/*`,
        arnFormat:    cdk.ArnFormat.SLASH_RESOURCE_NAME,
      })],
    }));

    logGroup.grantWrite(role);
    return role;
  }
}

function encryptedRoot(sizeGb = 10): ec2.BlockDevice {
  return {
    deviceName: '/dev/xvda',
    volume: ec2.BlockDeviceVolume.ebs(sizeGb, {
      encrypted:           true,
      volumeType:          ec2.EbsDeviceVolumeType.GP3,
      deleteOnTermination: true,
    }),
  };
}
