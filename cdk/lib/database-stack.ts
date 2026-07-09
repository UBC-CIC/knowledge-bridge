import { Stack, StackProps, RemovalPolicy, SecretValue } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";

import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";

import { VpcStack } from "./vpc-stack";

export class DatabaseStack extends Stack {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly secretPathAdminName: string;
  public readonly secretPathUser: secretsmanager.Secret;
  public readonly secretPathTableCreator: secretsmanager.Secret;
  public readonly rdsProxyEndpoint: string;

  constructor(
    scope: Construct,
    id: string,
    vpcStack: VpcStack,
    props?: StackProps
  ) {
    super(scope, id, props);

    const serviceLinkedRole = new cr.AwsCustomResource(
      this,
      `${id}-RDSServiceLinkedRoleResource`,
      {
      onCreate: {
        service: "IAM",
        action: "createServiceLinkedRole",
        parameters: {
          AWSServiceName: "rds.amazonaws.com",
        },
        ignoreErrorCodesMatching: "InvalidInput",
        physicalResourceId: cr.PhysicalResourceId.of("RDSServiceLinkedRole"),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["iam:CreateServiceLinkedRole"],
          resources: [
            `arn:aws:iam::${this.account}:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS`,
          ],
        }),
      ]),
      }
    );
    /**
     * Retrieve a secret from Secret Manager
     */
    const secret = secretmanager.Secret.fromSecretNameV2(
      this,
      "ImportedSecrets",
      "KBASecrets"
    );

    /**
     * Create Secrets for various users
     */
    this.secretPathAdminName = `${id}-KBA/credentials/rdsDbCredential`;
    const secretPathUserName = `${id}-KBA/userCredentials/rdsDbCredential`;
    this.secretPathUser = new secretsmanager.Secret(this, secretPathUserName, {
      secretName: secretPathUserName,
      description: "Secrets for clients to connect to RDS",
      removalPolicy: RemovalPolicy.DESTROY,
      secretObjectValue: {
        username: SecretValue.unsafePlainText("applicationUsername"), // will be changed at runtime
        password: SecretValue.unsafePlainText("applicationPassword"), // will be changed at runtime
      },
    });

    const secretPathTableCreator = `${id}-KBA/userCredentials/TableCreator`;
    this.secretPathTableCreator = new secretsmanager.Secret(
      this,
      secretPathTableCreator,
      {
        secretName: secretPathTableCreator,
        description: "Secrets for TableCreator to connect to RDS",
        removalPolicy: RemovalPolicy.DESTROY,
        secretObjectValue: {
          username: SecretValue.unsafePlainText("applicationUsername"), // will be changed at runtime
          password: SecretValue.unsafePlainText("applicationPassword"), // will be changed at runtime
        },
      }
    );

    const parameterGroup = new rds.ParameterGroup(
      this,
      `${id}-rdsParameterGroup`,
      {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16_8,
        }),
        description: "Empty parameter group",
        parameters: {
          "rds.force_ssl": "1",
        },
      }
    );

    /**
     * Create the RDS Postgres database
     */
    this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
      vpc: vpcStack.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_8,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MEDIUM
      ),
      credentials: rds.Credentials.fromUsername(
        secret.secretValueFromJson("DB_Username").unsafeUnwrap(),
        {
          secretName: this.secretPathAdminName,
        }
      ),
      multiAz: false,
      storageType: rds.StorageType.GP3,
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      allowMajorVersionUpgrade: false,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      autoMinorVersionUpgrade: true,
      backupRetention: Duration.days(7),
      deleteAutomatedBackups: true,
      deletionProtection: true,
      databaseName: "kba",
      publiclyAccessible: false,
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
      storageEncrypted: true, // storage encryption at rest
      monitoringInterval: Duration.seconds(60), // enhanced monitoring interval
      parameterGroup: parameterGroup,
    });

    // Allow Postgres only from the shared application SG — not from CIDR ranges.
    // This is least-privilege and self-adjusting as Lambdas are added/removed.
    const dbSecurityGroup = this.dbInstance.connections.securityGroups[0];
    dbSecurityGroup.addIngressRule(
      vpcStack.appSecurityGroup,
      ec2.Port.tcp(5432),
      "Postgres from application tier only"
    );
    dbSecurityGroup.addIngressRule(
      vpcStack.glueSecurityGroup,
      ec2.Port.tcp(5432),
      "Postgres from Glue ingestion job"
    );

    /**
     * Create IAM role for RDS Proxy
     */
    const rdsProxyRole = new iam.Role(this, `${id}-DBProxyRole`, {
      assumedBy: new iam.ServicePrincipal("rds.amazonaws.com"),
    });


    /**
     * Create RDS Proxy for database connections with all secrets
     */
    const secretPathAdmin = secretmanager.Secret.fromSecretNameV2(
      this,
      "AdminSecret",
      this.secretPathAdminName
    );

    const rdsProxy = this.dbInstance.addProxy(id + "-proxy", {
      secrets: [
        this.secretPathUser!,
        this.secretPathTableCreator!,
        secretPathAdmin,
      ],
      vpc: vpcStack.vpc,
      role: rdsProxyRole,
      securityGroups: this.dbInstance.connections.securityGroups,
      requireTLS: true,
    });

    rdsProxy.node.addDependency(serviceLinkedRole);

    /**
     * Workaround for TargetGroupName not being set automatically
     */
    let targetGroup = rdsProxy.node.children.find((child: any) => {
      return child instanceof rds.CfnDBProxyTargetGroup;
    }) as rds.CfnDBProxyTargetGroup;

    targetGroup.addPropertyOverride("TargetGroupName", "default");

    /**
     * Grant the role permission to connect to the database
     */
    this.dbInstance.grantConnect(rdsProxyRole);

    this.rdsProxyEndpoint = rdsProxy.endpoint;

    /**
     * Enable automatic secret rotation for database credentials
     * Note: Admin secret rotation already exists in the stack, so we only manage
     * rotation for application user and table creator credentials.
     */
    
    // 1. Admin credentials rotation is already configured - do not create duplicate
    // The existing rotation schedule for secretPathAdmin will remain active.

    // 2. Rotation for application user credentials (multi-user strategy)
    this.secretPathUser.addRotationSchedule("AppUserRot", {
      automaticallyAfter: Duration.days(30),
      hostedRotation: secretsmanager.HostedRotation.postgreSqlMultiUser({
        vpc: vpcStack.vpc,
        masterSecret: secretPathAdmin,
        functionName: `${id}-AppUserRotation`,
      }),
    });

    // 3. Rotation for table creator credentials (multi-user strategy)
    this.secretPathTableCreator.addRotationSchedule("TableCreatorRot", {
      automaticallyAfter: Duration.days(30),
      hostedRotation: secretsmanager.HostedRotation.postgreSqlMultiUser({
        vpc: vpcStack.vpc,
        masterSecret: secretPathAdmin,
        functionName: `${id}-TableCreatorRotation`,
      }),
    });

    // Note: AWS HostedRotation automatically creates and configures:
    // - Rotation Lambda functions in the VPC
    // - Required IAM permissions for Secrets Manager and RDS
    // - Security group rules for database connectivity
    // - Multi-user strategy creates alternating users (A/B) for zero-downtime rotation
  }
}
