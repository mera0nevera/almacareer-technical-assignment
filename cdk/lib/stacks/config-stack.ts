import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { IPS, DB, SSM_PATHS, SECRET_NAMES, LOG_GROUP_NAMES, LOG_RETENTION } from '../../config/const';

/**
 * ConfigStack – centralised parameter and secret storage.
 *
 * Why a separate stack?
 *  • Secrets and parameters outlive individual EC2 deployments.
 *  • Rotating a password or changing a hostname only requires updating
 *    this stack, not re-provisioning servers.
 *  • IAM access to specific Parameter Store paths / Secrets Manager ARNs
 *    is granted per-role, never via hardcoded env vars.
 */
export class ConfigStack extends cdk.Stack {
  // Exposed so ServersStack can grant IAM read access to instance roles.
  public readonly dbSecret: secretsmanager.Secret;
  public readonly dbHostParam: ssm.StringParameter;
  public readonly dbNameParam: ssm.StringParameter;
  public readonly dbUserParam: ssm.StringParameter;

  // CloudWatch log groups (created here so they survive instance replacement)
  public readonly haproxyLogs: logs.LogGroup;
  public readonly webLogs: logs.LogGroup;
  public readonly dbLogs: logs.LogGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Secrets Manager ───────────────────────────────────────────────────────
    // Passwords go here, not in Parameter Store – Secrets Manager supports
    // automatic rotation, fine-grained IAM access, and a full audit trail.
    this.dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: SECRET_NAMES.dbCredentials,
      description: 'LMC application database password',
      secretObjectValue: {
        // In production, remove this line and enable automatic rotation instead.
        password: cdk.SecretValue.unsafePlainText(DB.password),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── SSM Parameter Store ───────────────────────────────────────────────────
    // Non-sensitive config (hostnames, names) lives here.
    // Changing a parameter re-deploys only this stack; instances pick it up
    // on next restart of fetch-app-config.service (or via SSM Run Command).
    this.dbHostParam = new ssm.StringParameter(this, 'DbHost', {
      parameterName: SSM_PATHS.dbHost,
      stringValue: IPS.db,
      description: 'Database private IP',
    });

    this.dbNameParam = new ssm.StringParameter(this, 'DbName', {
      parameterName: SSM_PATHS.dbName,
      stringValue: DB.name,
      description: 'Database name',
    });

    this.dbUserParam = new ssm.StringParameter(this, 'DbUser', {
      parameterName: SSM_PATHS.dbUser,
      stringValue: DB.user,
      description: 'Database application user',
    });

    // ── CloudWatch Log Groups ─────────────────────────────────────────────────
    // Created here (not by the instance) so they persist across replacements
    // and share a common retention policy.
    this.haproxyLogs = new logs.LogGroup(this, 'HaproxyLogs', {
      logGroupName: LOG_GROUP_NAMES.haproxy,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.webLogs = new logs.LogGroup(this, 'WebLogs', {
      logGroupName: LOG_GROUP_NAMES.web,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.dbLogs = new logs.LogGroup(this, 'DbLogs', {
      logGroupName: LOG_GROUP_NAMES.db,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: this.dbSecret.secretArn,
      description: 'Rotate DB password: aws secretsmanager rotate-secret --secret-id <ARN>',
    });
    new cdk.CfnOutput(this, 'UpdateDbHost', {
      value: `aws ssm put-parameter --name ${SSM_PATHS.dbHost} --value <NEW_IP> --overwrite`,
      description: 'Update DB host without re-deploying servers',
    });
  }
}
