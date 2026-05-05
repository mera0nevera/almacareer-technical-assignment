import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { GITHUB_OIDC, TIMEOUTS } from '../../config/const';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** GitHub organisation or username, e.g. "ruslan-krymtsov" */
  githubOrg: string;
  /** Repository name, e.g. "lmc" */
  githubRepo: string;
  /**
   * Which refs are allowed to assume the deploy role.
   * Default: only the main branch.
   * Use "*" to allow any branch (not recommended for production).
   */
  allowedRef?: string;
}

/**
 * GithubOidcStack – one-time bootstrap stack.
 *
 * Creates the GitHub OIDC identity provider and an IAM role that GitHub
 * Actions can assume without any long-lived AWS access keys.
 *
 * Deploy ONCE before the CI/CD pipeline can run:
 *   cd cdk && cdk deploy LmcGithubOidc \
 *     -c githubOrg=YOUR_ORG -c githubRepo=YOUR_REPO
 *
 * Then add the output role ARN as GitHub secret: AWS_DEPLOY_ROLE_ARN
 */
export class GithubOidcStack extends cdk.Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const allowedRef = props.allowedRef ?? process.env.GITHUB_BRANCH ?? GITHUB_OIDC.defaultRef;

    // ── OIDC Provider ─────────────────────────────────────────────────────────
    // GitHub publishes its OIDC config at this URL.
    // AWS uses it to verify tokens issued by GitHub Actions.
    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      thumbprints: [GITHUB_OIDC.thumbprint],
    });

    // ── IAM Role assumed by GitHub Actions ────────────────────────────────────
    this.deployRole = new iam.Role(this, 'GithubActionsDeployRole', {
      roleName: 'github-actions-lmc-deploy',
      description: `Deploy role for ${props.githubOrg}/${props.githubRepo}`,
      // Trust policy: only this specific repo + ref can assume the role
      assumedBy: new iam.WebIdentityPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            // Restrict to the specific repo and ref pattern
            'token.actions.githubusercontent.com:sub':
              `repo:${props.githubOrg}/${props.githubRepo}:${allowedRef}`,
          },
        }
      ),
      maxSessionDuration: TIMEOUTS.oidcSession,
    });

    // ── Permissions ───────────────────────────────────────────────────────────
    // Scoped to the exact set of services this pipeline uses: CDK CloudFormation
    // bootstrap + deploy, EC2 instance lifecycle, IAM for CDK-created instance
    // roles, SSM parameters, Secrets Manager, CloudWatch Logs, S3 asset bucket,
    // KMS for encrypted EBS, and STS for cross-account token operations.
    // iam:* on * is still broad; a future tightening would add a resource
    // condition on iam:ResourceTag/Project=lmc once all IAM resources are tagged.
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CdkDeploy',
      actions: [
        // 'cloudformation:*',
        // 'ec2:*',
        // 'iam:*',
        // 'ssm:*',
        // 'secretsmanager:*',
        // 'logs:*',
        // 's3:*',
        // 'kms:*',
        'sts:AssumeRole'
        // 'sts:GetCallerIdentity',
        // 'sts:TagSession',
      ],
      resources: ['*'],
    }));

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Add as GitHub secret: AWS_DEPLOY_ROLE_ARN',
    });
    new cdk.CfnOutput(this, 'GithubSetupInstructions', {
      value: [
        'GitHub → Settings → Secrets → New secret',
        `Name: AWS_DEPLOY_ROLE_ARN`,
        `Value: ${this.deployRole.roleArn}`,
      ].join(' | '),
    });
  }
}
