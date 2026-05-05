#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack }    from '../lib/stacks/network-stack';
import { ConfigStack }     from '../lib/stacks/config-stack';
import { ServersStack }    from '../lib/stacks/servers-stack';
import { GithubOidcStack } from '../lib/stacks/github-oidc-stack';
import { GITHUB_OIDC }     from '../config/const';

const app = new cdk.App();

// Tag every resource in every stack – visible in cost explorer and resource groups.
cdk.Tags.of(app).add('Project', 'lmc');

// Read GitHub repo info from context (--context flags) or environment
const githubOrg  = app.node.tryGetContext('githubOrg')  ?? process.env.GITHUB_ORG  ?? GITHUB_OIDC.defaultOrg;
const githubRepo = app.node.tryGetContext('githubRepo') ?? process.env.GITHUB_REPO ?? GITHUB_OIDC.defaultRepo;

// ── One-time bootstrap: GitHub OIDC trust ─────────────────────────────────────
// Deploy once, then add the output role ARN to GitHub Secrets.
// cdk deploy LmcGithubOidc -c githubOrg=my-org -c githubRepo=lmc
new GithubOidcStack(app, 'LmcGithubOidc', { githubOrg, githubRepo });

// ── Main application stacks ───────────────────────────────────────────────────
// Stacks are environment-agnostic so CDK does not need ec2:DescribeAvailabilityZones
// at synth time. Account and region resolve from active credentials at deploy time.

const network = new NetworkStack(app, 'LmcNetwork', {
  description: 'LMC VPC, subnets, and security groups',
  terminationProtection: true,
});

const config = new ConfigStack(app, 'LmcConfig', {
  description: 'LMC secrets, SSM parameters, and CloudWatch log groups',
  terminationProtection: true,
});

new ServersStack(app, 'LmcServers', {
  description: 'LMC HAProxy, web, and database EC2 instances',
  terminationProtection: true,
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
