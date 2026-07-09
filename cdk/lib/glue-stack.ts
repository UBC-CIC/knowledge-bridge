import * as cdk from "aws-cdk-lib";
import * as glue from "aws-cdk-lib/aws-glue";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";

export class GlueStack extends cdk.Stack {
  public readonly jobName: string;

  constructor(
    scope: Construct,
    id: string,
    vpcStack: VpcStack,
    dbStack: DatabaseStack,
    props: cdk.StackProps
  ) {
    super(scope, id, props);

    const scriptAsset = new s3assets.Asset(this, "GlueScriptAsset", {
      path: "./glue/sharepoint_ingestion.py",
    });

    // Glue SG is owned by VpcStack so DatabaseStack can reference it without
    // creating a cross-stack cycle (GlueStack → DatabaseStack already exists).
    const glueSecurityGroup = vpcStack.glueSecurityGroup;

    // IAM role for the Glue job — least privilege
    const glueRole = new iam.Role(this, `${id}-GlueJobRole`, {
      roleName: `${id}-GlueJobRole`,
      assumedBy: new iam.ServicePrincipal("glue.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole"),
      ],
    });

    // Secrets Manager — only the three SharePoint secrets + DB user secret
    glueRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:KBA-SharePoint-Credentials*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:Sharepoint-REST-Cert-Pfx-B64*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:Sharepoint-REST-Cert-Pfx-Password*`,
        dbStack.secretPathUser.secretArn,
      ],
    }));

    // Bedrock — Cohere embed + Claude Haiku for narration
    glueRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-english-v3`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
      ],
    }));

    // VPC / ENI
    glueRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
      ],
      resources: ["*"],
    }));

    // CloudWatch Logs
    glueRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws-glue/*`],
    }));

    // S3
    scriptAsset.grantRead(glueRole);
    glueRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      resources: [`arn:aws:s3:::aws-glue-assets-${this.account}-${this.region}/*`],
    }));

    // secretPathUser already granted above via inline secretsmanager policy

    // Glue VPC connection — uses private-with-egress subnet so NAT is available
    // for Microsoft Graph API calls while still being able to reach RDS Proxy
    const privateSubnet = vpcStack.vpc.privateSubnets[0];
    const connectionName = `${id}-VpcConnection`;

    const glueConnection = new glue.CfnConnection(this, `${id}-GlueConnection`, {
      catalogId: this.account,
      connectionInput: {
        name: connectionName,
        connectionType: "NETWORK",
        physicalConnectionRequirements: {
          subnetId: privateSubnet.subnetId,
          securityGroupIdList: [glueSecurityGroup.securityGroupId],
          availabilityZone: privateSubnet.availabilityZone,
        },
      },
    });

    this.jobName = `${id}-SharePointIngestion`;

    const glueJob = new glue.CfnJob(this, `${id}-GlueJob`, {
      name: this.jobName,
      role: glueRole.roleArn,
      command: {
        name: "pythonshell",
        pythonVersion: "3.9",
        scriptLocation: scriptAsset.s3ObjectUrl,
      },
      connections: {
        connections: [connectionName],
      },
      defaultArguments: {
        "--SHAREPOINT_SECRET_NAME": "KBA-SharePoint-Credentials",
        "--SHAREPOINT_CERT_SECRET": "Sharepoint-REST-Cert-Pfx-B64",
        "--SHAREPOINT_CERT_PASSWORD_SECRET": "Sharepoint-REST-Cert-Pfx-Password",
        "--DB_SECRET_NAME": dbStack.secretPathUser.secretName,
        "--RDS_PROXY_ENDPOINT": dbStack.rdsProxyEndpoint,
        "--FORCE_FULL": "false",
        "--TRIGGERED_BY": "manual",
        "--additional-python-modules": "boto3==1.34.0,botocore==1.34.0,azure-identity==1.21.0,msgraph-sdk==1.27.0,psycopg2-binary==2.9.9,httpx==0.27.0,requests==2.32.3",
        "--enable-continuous-cloudwatch-log": "true",
        "--enable-continuous-log-filter": "false",
      },
      maxCapacity: 1,
      maxRetries: 0,
      timeout: 120,
      executionProperty: {
        maxConcurrentRuns: 1,
      },
      glueVersion: "3.0",
    });

    glueJob.addDependency(glueConnection);

    new cdk.CfnOutput(this, "GlueJobName", {
      value: this.jobName,
      exportName: `${id}-GlueJobName`,
    });
  }
}
