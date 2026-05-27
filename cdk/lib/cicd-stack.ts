import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as codeconnections from "aws-cdk-lib/aws-codeconnections";
import * as s3 from "aws-cdk-lib/aws-s3";

interface LambdaConfig {
  name: string; // Module name (e.g., "textGeneration")
  functionName: string; // Lambda function name
  sourceDir: string; // Source directory for Docker build
}

interface CICDStackProps extends cdk.StackProps {
  githubRepo: string;
  githubBranch?: string;
  environmentName?: string;
  lambdaFunctions: LambdaConfig[];
  pathFilters?: string[];
}

export class CICDStack extends cdk.Stack {
  public readonly ecrRepositories: { [key: string]: ecr.Repository } = {};
  public readonly buildProjects: { [key: string]: codebuild.IProject } = {};
  public readonly pipelineName: string;

  constructor(scope: Construct, id: string, props: CICDStackProps) {
    super(scope, id, props);

    const envName = props.environmentName ?? "dev";
    this.pipelineName = `${id}-DockerImagePipeline`;

    // Create a common role for all CodeBuild projects
    const codeBuildRole = new iam.Role(this, "DockerBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    codeBuildRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryPowerUser"
      )
    );

    if (props.lambdaFunctions.length > 0) {
      const lambdaUpdateArns = props.lambdaFunctions.map(
        (fn) => `arn:aws:lambda:${this.region}:${this.account}:function:${fn.functionName}`
      );

      codeBuildRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "lambda:GetFunction",
            "lambda:UpdateFunctionCode",
            "lambda:UpdateFunctionConfiguration",
          ],
          resources: lambdaUpdateArns,
        })
      );

      const sourceOutput = new codepipeline.Artifact();

      const artifactAccessLogsBucket = new s3.Bucket(this, "ArtifactAccessLogs", {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        enforceSSL: true,
      });

      const artifactBucket = new s3.Bucket(this, "PipelineArtifactBucket", {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        enforceSSL: true,
        serverAccessLogsBucket: artifactAccessLogsBucket,
        serverAccessLogsPrefix: "pipeline-artifacts/",
      });

      const pipeline = new codepipeline.Pipeline(this, "DockerImagePipeline", {
        pipelineName: this.pipelineName,
        artifactBucket: artifactBucket,
      });

      const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        "kba-owner-name"
      );

      const githubConnection = new codeconnections.CfnConnection(
        this,
        "GitHubConnection",
        {
          connectionName: `${id}-github-conn`,
          providerType: "GitHub",
        }
      );

      new cdk.CfnOutput(this, "GitHubConnectionArn", {
        value: githubConnection.attrConnectionArn,
        description: "ARN of the GitHub connection. After deployment, authorize this connection in the AWS Console.",
      });

      pipeline.addStage({
        stageName: "Source",
        actions: [
          new codepipeline_actions.CodeStarConnectionsSourceAction({
            actionName: "GitHub",
            owner: username,
            repo: props.githubRepo,
            branch: props.githubBranch ?? "main",
            connectionArn: githubConnection.attrConnectionArn,
            output: sourceOutput,
            triggerOnPush: true,
          }),
        ],
      });

      const buildActions: codepipeline_actions.CodeBuildAction[] = [];

      props.lambdaFunctions.forEach((lambda) => {
        const repoName = `${id.toLowerCase()}-${lambda.name.toLowerCase()}`;
        const ecrRepo = new ecr.Repository(this, `${lambda.name}Repo`, {
          repositoryName: repoName,
          imageTagMutability: ecr.TagMutability.MUTABLE,
          removalPolicy: cdk.RemovalPolicy.RETAIN,
          imageScanOnPush: true,
        });

        ecrRepo.addToResourcePolicy(
          new iam.PolicyStatement({
            sid: "LambdaPullAccess",
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
            actions: [
              "ecr:GetDownloadUrlForLayer",
              "ecr:BatchGetImage",
              "ecr:BatchCheckLayerAvailability",
            ],
            conditions: {
              StringEquals: {
                "aws:SourceAccount": this.account,
              },
            },
          })
        );

        this.ecrRepositories[lambda.name] = ecrRepo;
        cdk.Tags.of(ecrRepo).add("module", lambda.name);
        cdk.Tags.of(ecrRepo).add("env", envName);

        const buildProject = new codebuild.PipelineProject(
          this,
          `${lambda.name}BuildProject`,
          {
            projectName: `${id}-${lambda.name}Builder`,
            role: codeBuildRole,
            environment: {
              buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
              privileged: true,
            },
            environmentVariables: {
              AWS_ACCOUNT_ID: { value: this.account },
              AWS_REGION: { value: this.region },
              ENVIRONMENT: { value: envName },
              MODULE_NAME: { value: lambda.name },
              LAMBDA_FUNCTION_NAME: { value: lambda.functionName },
              REPO_NAME: { value: repoName },
              REPOSITORY_URI: { value: ecrRepo.repositoryUri },
              GITHUB_USERNAME: { value: username },
              GITHUB_REPO: { value: props.githubRepo },
              PATH_FILTER: { value: lambda.sourceDir },
            },
            buildSpec: codebuild.BuildSpec.fromObject({
              version: "0.2",
              phases: {
                pre_build: {
                  commands: [
                    "echo Logging in to Amazon ECR...",
                    "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com",
                    'echo "#!/bin/bash" > check_and_build.sh',
                    'echo "set -e" >> check_and_build.sh',
                    'echo "cd $CODEBUILD_SRC_DIR" >> check_and_build.sh',
                    'echo "if ! aws ecr describe-images --repository-name $REPO_NAME --image-ids imageTag=latest &>/dev/null; then" >> check_and_build.sh',
                    'echo "  exit 0" >> check_and_build.sh',
                    'echo "fi" >> check_and_build.sh',
                    'echo "if [ ! -d .git ]; then" >> check_and_build.sh',
                    'echo "  exit 0" >> check_and_build.sh',
                    'echo "fi" >> check_and_build.sh',
                    'echo "PREV_COMMIT=\\$(git rev-parse HEAD~1 || echo \\\"\\\")" >> check_and_build.sh',
                    'echo "if [ -z \\\"\\$PREV_COMMIT\\\" ]; then" >> check_and_build.sh',
                    'echo "  exit 0" >> check_and_build.sh',
                    'echo "fi" >> check_and_build.sh',
                    'echo "CHANGED_FILES=\\$(git diff --name-only \\$PREV_COMMIT HEAD)" >> check_and_build.sh',
                    'echo "if ! echo \\\"\\$CHANGED_FILES\\\" | grep -q \\\"^$PATH_FILTER/\\\"; then" >> check_and_build.sh',
                    'echo "  exit 1" >> check_and_build.sh',
                    'echo "fi" >> check_and_build.sh',
                    'echo "exit 0" >> check_and_build.sh',
                    "chmod +x check_and_build.sh",
                    "COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)",
                    "IMAGE_TAG=${MODULE_NAME}-${ENVIRONMENT}-${COMMIT_HASH}",
                    "export DOCKER_HOST=unix:///var/run/docker.sock",
                    './check_and_build.sh || { echo "Skipping build due to no changes"; exit 1; }',
                  ],
                },
                build: {
                  commands: [
                    'echo "Building Docker image..."',
                    `docker build -t $REPOSITORY_URI:$IMAGE_TAG $CODEBUILD_SRC_DIR/${lambda.sourceDir} -f $CODEBUILD_SRC_DIR/${lambda.sourceDir}/Dockerfile`,
                  ],
                },
                post_build: {
                  commands: [
                    "docker tag $REPOSITORY_URI:$IMAGE_TAG $REPOSITORY_URI:latest",
                    "docker push $REPOSITORY_URI:$IMAGE_TAG",
                    "docker push $REPOSITORY_URI:latest",
                    "sleep 30",
                    `bash -c '
                      SCAN_RESULTS=$(aws ecr describe-image-scan-findings \
                        --repository-name $REPO_NAME \
                        --image-id imageTag=latest \
                        --query "imageScanFindingsSummary.findingCounts.CRITICAL" \
                        --output text 2>/dev/null || echo "0")
                      if [[ "$SCAN_RESULTS" != "0" && "$SCAN_RESULTS" != "None" ]]; then
                        echo "CRITICAL vulnerabilities found: $SCAN_RESULTS. Blocking deployment."
                        exit 1
                      fi
                    '`,
                    `bash -c '
                      if aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME &>/dev/null; then
                        aws lambda update-function-code \
                          --function-name $LAMBDA_FUNCTION_NAME \
                          --image-uri $REPOSITORY_URI:latest
                      fi
                    '`,
                  ],
                },
              },
            }),
          }
        );

        this.buildProjects[lambda.name] = buildProject;

        buildActions.push(
          new codepipeline_actions.CodeBuildAction({
            actionName: `Build_${lambda.name}`,
            project: buildProject,
            input: sourceOutput,
          })
        );
      });

      pipeline.addStage({
        stageName: "Build",
        actions: buildActions,
      });
    }
  }
}