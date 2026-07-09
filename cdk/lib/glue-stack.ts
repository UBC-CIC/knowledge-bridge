import * as cdk from "aws-cdk-lib";
import * as glue from "@aws-cdk/aws-glue-alpha";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";

// Read requirements.txt at synth time and convert to comma-separated string
// for --additional-python-modules (Python Shell on Glue 3.0 does not support
// the native -r installer option — that requires Glue 5.0 + Python 3.11).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const additionalModules: string = (require("fs") as typeof import("fs"))
  .readFileSync("./glue/requirements.txt", "utf-8")
  .split("\n")
  .map((l: string) => l.trim())
  .filter((l: string) => l && !l.startsWith("#"))
  .join(",");

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

    // VPC / ENI — required by Glue VPC connections
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

    // S3 — glue assets bucket
    glueRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      resources: [`arn:aws:s3:::aws-glue-assets-${this.account}-${this.region}/*`],
    }));

    const privateSubnet = vpcStack.vpc.privateSubnets[0];
    const connectionName = `${id}-VpcConnection`;

    // Glue VPC connection — uses private-with-egress subnet so NAT is available
    // for Microsoft Graph API calls while still being able to reach RDS Proxy
    const glueConnection = new glue.Connection(this, `${id}-GlueConnection`, {
      connectionName,
      type: glue.ConnectionType.NETWORK,
      subnet: privateSubnet,
      securityGroups: [glueSecurityGroup],
    });
    (glueConnection.node.defaultChild as cdk.CfnResource).overrideLogicalId("KBAGlueGlueConnection");

    this.jobName = `${id}-SharePointIngestion`;

    const glueJob = new glue.PythonShellJob(this, `${id}-GlueJob`, {
      jobName: this.jobName,
      role: glueRole,
      script: glue.Code.fromAsset("./glue/sharepoint_ingestion.py"),
      glueVersion: glue.GlueVersion.V3_0,
      pythonVersion: glue.PythonVersion.THREE_NINE,
      maxCapacity: glue.MaxCapacity.DPU_1_16TH,
      connections: [glueConnection],
      maxRetries: 1,
      timeout: cdk.Duration.minutes(120),
      maxConcurrentRuns: 1,
      defaultArguments: {
        "--SHAREPOINT_SECRET_NAME": "KBA-SharePoint-Credentials",
        "--SHAREPOINT_CERT_SECRET": "Sharepoint-REST-Cert-Pfx-B64",
        "--SHAREPOINT_CERT_PASSWORD_SECRET": "Sharepoint-REST-Cert-Pfx-Password",
        "--DB_SECRET_NAME": dbStack.secretPathUser.secretName,
        "--RDS_PROXY_ENDPOINT": dbStack.rdsProxyEndpoint,
        "--FORCE_FULL": "false",
        "--TRIGGERED_BY": "manual",
        "--additional-python-modules": additionalModules,
        "--enable-continuous-cloudwatch-log": "true",
        "--enable-continuous-log-filter": "false",
      },
    });

    (glueJob.node.defaultChild as cdk.CfnResource).overrideLogicalId("KBAGlueGlueJob");
    glueJob.node.addDependency(glueConnection);

    new cdk.CfnOutput(this, "GlueJobName", {
      value: this.jobName,
      exportName: `${id}-GlueJobName`,
    });
  }
}
