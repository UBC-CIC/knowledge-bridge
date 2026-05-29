import {
  App,
  GitHubSourceCodeProvider,
  RedirectStatus,
} from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import { BuildSpec } from "aws-cdk-lib/aws-codebuild";
import { Construct } from "constructs";
import * as yaml from "yaml";
import { ApiGatewayStack } from "./api-stack";

interface AmplifyStackProps extends cdk.StackProps {
  githubRepo: string;
  githubBranch?: string;
  allowedOriginsParamName: string;
}

export class AmplifyStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    apiStack: ApiGatewayStack,
    props: AmplifyStackProps
  ) {
    super(scope, id, props);

    const githubRepoName = props.githubRepo;

    const amplifyYaml = yaml.parse(`
      version: 1
      applications:
        - appRoot: frontend
          frontend:
            phases:
              preBuild:
                commands:
                  - pwd
                  - npm ci
              build:
                commands:
                  - npm run build
            artifacts:
              baseDirectory: dist
              files:
                - '**/*'
            cache:
              paths:
                - 'node_modules/**/*'
            redirects:
              - source: </^[^.]+$|.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>
                target: /
                status: 404
    `);

    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "kba-owner-name"
    );

    const branch = props.githubBranch ?? "main";

    // TODO: fix cyclic dependency — VITE_APP_URL is hardcoded because amplifyApp.appId
    // cannot be referenced inside its own constructor. appId is stable after first deploy.
    const amplifyAppUrl = "https://main.d3oad47ldjyoe6.amplifyapp.com";

    const amplifyApp = new App(this, `${id}-amplifyApp`, {
      appName: `${id}-amplify`,
      sourceCodeProvider: new GitHubSourceCodeProvider({
        owner: username,
        repository: githubRepoName,
        oauthToken: cdk.SecretValue.secretsManager(
          "github-personal-access-token",
          {
            jsonField: "my-github-token",
          }
        ),
      }),
      environmentVariables: {
        VITE_AWS_REGION: this.region,
        VITE_COGNITO_USER_POOL_ID: apiStack.getUserPoolId(),
        VITE_COGNITO_USER_POOL_CLIENT_ID: apiStack.getUserPoolClientId(),
        VITE_API_ENDPOINT: apiStack.getEndpointUrl(),
        VITE_IDENTITY_POOL_ID: apiStack.getIdentityPoolId(),
        VITE_WEBSOCKET_URL: `${apiStack.getWebSocketUrl()}/${apiStack.getStageName() ?? ""
          }`,
        VITE_APP_URL: amplifyAppUrl,
      },
      buildSpec: BuildSpec.fromObjectToYaml(amplifyYaml),
    });

    amplifyApp.addCustomRule({
      source: "/<*>",
      target: "\t/index.html",
      status: RedirectStatus.NOT_FOUND_REWRITE,
    });

    // Add main branch
    amplifyApp.addBranch("main");

    // Add feature branch if specified and not main
    if (branch !== "main") {
      amplifyApp.addBranch(branch);
    }

    // -- UPDATE THE SSM PARAMETER TO POINT TO THE AMPLIFY APP URL --
    const amplifyUrl = `https://${branch}.${amplifyApp.appId}.amplifyapp.com`;

    // Set the allowed origins to the Amplify URL.
    // To add additional origins (e.g. custom domains), update the SSM parameter manually.
    // See Docs/DEPLOYMENT_GUIDE.md for instructions.
    new cdk.custom_resources.AwsCustomResource(this, "UpdateSSMAllowedOrigins", {
      onCreate: {
        service: "SSM",
        action: "putParameter",
        parameters: {
          Name: props.allowedOriginsParamName,
          Value: amplifyUrl,
          Type: "String",
          Overwrite: true,
        },
        physicalResourceId: cdk.custom_resources.PhysicalResourceId.of("UpdateSSMAllowedOrigins"),
      },
      policy: cdk.custom_resources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${props.allowedOriginsParamName}`,
        ],
      }),
    });

  }
}
