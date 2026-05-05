import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../lib/stacks/network-stack';
import { ConfigStack }  from '../../lib/stacks/config-stack';
import { ServersStack } from '../../lib/stacks/servers-stack';

function buildTemplates() {
  const app = new cdk.App();
  const network  = new NetworkStack(app, 'Net');
  const config   = new ConfigStack(app, 'Cfg');
  const servers  = new ServersStack(app, 'Srv', {
    vpc:          network.vpc,
    haproxySg:    network.haproxySg,
    webSg:        network.webSg,
    dbSg:         network.dbSg,
    dbSecret:     config.dbSecret,
    dbHostParam:  config.dbHostParam,
    dbNameParam:  config.dbNameParam,
    dbUserParam:  config.dbUserParam,
    haproxyLogs:  config.haproxyLogs,
    webLogs:      config.webLogs,
    dbLogs:       config.dbLogs,
  });
  return {
    servers:  Template.fromStack(servers),
    network:  Template.fromStack(network),
    cfgStack: Template.fromStack(config),
  };
}

describe('ServersStack', () => {
  let t: Template;
  beforeAll(() => { ({ servers: t } = buildTemplates()); });

  test('creates exactly 4 EC2 instances', () => {
    t.resourceCountIs('AWS::EC2::Instance', 4);
  });

  test('all instances use encrypted GP3 root volume', () => {
    // CDK puts blockDevices directly on the Instance resource, not the LaunchTemplate
    t.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: [{ Ebs: { Encrypted: true, VolumeType: 'gp3' } }],
    });
  });

  test('IMDSv2 is required on all instances', () => {
    t.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: {
        MetadataOptions: { HttpTokens: 'required' },
      },
    });
  });

  test('each instance has an IAM instance profile', () => {
    // 4 instances → 4 instance profiles
    t.resourceCountIs('AWS::IAM::InstanceProfile', 4);
  });

  test('IAM roles include SSM and CloudWatch managed policies', () => {
    // ManagedPolicyArns are Fn::Join objects in the template, not plain strings.
    // Match on the policy name substring inside the join array.
    t.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: cdk.assertions.Match.arrayWith([
        cdk.assertions.Match.objectLike({ 'Fn::Join': cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.arrayWith([
            cdk.assertions.Match.stringLikeRegexp('AmazonSSMManagedInstanceCore'),
          ]),
        ])}),
      ]),
    });
  });
});

describe('NetworkStack security groups', () => {
  let t: Template;
  beforeAll(() => { ({ network: t } = buildTemplates()); });

  test('creates 3 security groups (haproxy, web, db)', () => {
    t.resourceCountIs('AWS::EC2::SecurityGroup', 3);
  });

  test('HAProxy SG allows port 80 from internet', () => {
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'HAProxy – public entry point',
      SecurityGroupIngress: cdk.assertions.Match.arrayWith([
        cdk.assertions.Match.objectLike({ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' }),
      ]),
    });
  });

  test('DB SG allows port 3306 from web SG', () => {
    // Cross-SG rules are emitted as separate AWS::EC2::SecurityGroupIngress resources
    t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306,
    });
  });
});

describe('ConfigStack', () => {
  let t: Template;
  beforeAll(() => { ({ cfgStack: t } = buildTemplates()); });

  test('creates a Secrets Manager secret for DB password', () => {
    t.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  test('creates SSM parameters for DB host, name, and user', () => {
    t.resourceCountIs('AWS::SSM::Parameter', 3);
  });

  test('creates 3 CloudWatch log groups', () => {
    t.resourceCountIs('AWS::Logs::LogGroup', 3);
  });
});
