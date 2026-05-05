import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { AVAILABILITY_ZONE, VPC_CIDR, PORTS } from '../../config/const';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly haproxySg: ec2.SecurityGroup;
  public readonly webSg: ec2.SecurityGroup;
  public readonly dbSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Single public subnet – web/db access is controlled by security groups.
    // In production use private subnets + NAT gateway for web/db nodes.
    // availabilityZones is specified explicitly to avoid ec2:DescribeAvailabilityZones
    // context lookup at synth time.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName:     'lmc-vpc',
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      availabilityZones: [AVAILABILITY_ZONE],
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: true,
        },
      ],
    });

    // ── HAProxy SG ───────────────────────────────────────────────────────────
    // Public entry point: HTTP from internet, stats page, SSH for admin.
    this.haproxySg = new ec2.SecurityGroup(this, 'HaproxySg', {
      vpc: this.vpc,
      securityGroupName: 'lmc-haproxy-sg',
      description: 'HAProxy - public entry point',
      allowAllOutbound: true,
    });
    this.haproxySg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(PORTS.http),         'HTTP from internet');
    this.haproxySg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(PORTS.haproxyStats), 'HAProxy stats page');
    this.haproxySg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(PORTS.ssh),          'SSH admin');

    // ── Web SG ───────────────────────────────────────────────────────────────
    // Only HAProxy can reach port 80; SSH is open for admin convenience.
    this.webSg = new ec2.SecurityGroup(this, 'WebSg', {
      vpc: this.vpc,
      securityGroupName: 'lmc-web-sg',
      description: 'Web servers - HTTP only from HAProxy',
      allowAllOutbound: true,
    });
    this.webSg.addIngressRule(this.haproxySg,    ec2.Port.tcp(PORTS.http), 'HTTP from HAProxy');
    this.webSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(PORTS.ssh),  'SSH admin');

    // ── DB SG ────────────────────────────────────────────────────────────────
    // MySQL only reachable from web servers; no direct internet exposure.
    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      securityGroupName: 'lmc-db-sg',
      description: 'Database - MySQL only from web servers',
      allowAllOutbound: true,
    });
    this.dbSg.addIngressRule(this.webSg,          ec2.Port.tcp(PORTS.mysql), 'MySQL from web servers');
    this.dbSg.addIngressRule(ec2.Peer.anyIpv4(),  ec2.Port.tcp(PORTS.ssh),   'SSH admin');

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
