const { ECRClient, DescribeImagesCommand } = require("@aws-sdk/client-ecr");
const {
  CodeBuildClient,
  StartBuildCommand,
} = require("@aws-sdk/client-codebuild");
const {
  CodePipelineClient,
  StartPipelineExecutionCommand,
} = require("@aws-sdk/client-codepipeline");

const ecr = new ECRClient({});
const codebuild = new CodeBuildClient({});
const codepipeline = new CodePipelineClient({});

/**
 * Custom resource handler that waits for a Docker image to exist in ECR
 * This prevents race conditions where Lambda functions are created before images are built
 */
exports.handler = async (event, context) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  const { RequestType, ResourceProperties, PhysicalResourceId } = event;
  const {
    RepositoryName,
    ImageTag,
    MaxRetries = "60",
    RetryDelaySeconds = "30",
    CodeBuildProjectName,
    CodePipelineName,
    TriggerBuildOnMissing = "false",
  } = ResourceProperties;

  const maxRetries = parseInt(MaxRetries);
  const retryDelay = parseInt(RetryDelaySeconds) * 1000; // Convert to milliseconds

  try {
    if (RequestType === "Delete") {
      // No cleanup needed for delete operations
      await sendResponse(
        event,
        context,
        "SUCCESS",
        {
          Message: "Image waiter resource deleted successfully",
        },
        PhysicalResourceId
      );
      return;
    }

    // For Create and Update, check if image exists
    const physicalId =
      PhysicalResourceId || `ecr-image-waiter-${RepositoryName}-${ImageTag}`;

    console.log(
      `Checking for image in repository: ${RepositoryName}, tag: ${ImageTag}`
    );
    console.log(`Max retries: ${maxRetries}, retry delay: ${retryDelay}ms`);

    let retries = 0;
    let imageExists = false;

    let buildTriggered = false;

    while (retries < maxRetries && !imageExists) {
      try {
        const command = new DescribeImagesCommand({
          repositoryName: RepositoryName,
          imageIds: [{ imageTag: ImageTag }],
        });

        const response = await ecr.send(command);

        if (response.imageDetails && response.imageDetails.length > 0) {
          imageExists = true;
          console.log(
            `Image found in repository ${RepositoryName} with tag ${ImageTag}`
          );
          console.log(
            "Image details:",
            JSON.stringify(response.imageDetails[0], null, 2)
          );
        }
      } catch (error) {
        if (
          error.name === "ImageNotFoundException" ||
          error.name === "RepositoryNotFoundException"
        ) {
          retries++;
          console.log(
            `Image not found yet (attempt ${retries}/${maxRetries}). Waiting ${
              retryDelay / 1000
            } seconds...`
          );

          // On first miss, optionally trigger a CodePipeline execution or CodeBuild build.
          if (
            !buildTriggered &&
            TriggerBuildOnMissing.toString().toLowerCase() === "true"
          ) {
            try {
              if (CodePipelineName) {
                console.log(
                  `Starting CodePipeline execution for ${CodePipelineName} to build the image...`
                );
                await codepipeline.send(
                  new StartPipelineExecutionCommand({ name: CodePipelineName })
                );
                buildTriggered = true;
              } else if (CodeBuildProjectName) {
                console.log(
                  `Starting CodeBuild project ${CodeBuildProjectName} to build the image...`
                );
                await codebuild.send(
                  new StartBuildCommand({ projectName: CodeBuildProjectName })
                );
                buildTriggered = true;
              } else {
                console.warn(
                  "TriggerBuildOnMissing=true but neither CodePipelineName nor CodeBuildProjectName was provided."
                );
              }
            } catch (cbError) {
              const triggerTarget = CodePipelineName
                ? `CodePipeline ${CodePipelineName}`
                : `CodeBuild project ${CodeBuildProjectName}`;
              console.error(`Failed to start ${triggerTarget}:`, cbError);
            }
          }

          if (retries < maxRetries) {
            await sleep(retryDelay);
          }
        } else {
          // Unexpected error
          throw error;
        }
      }
    }

    if (!imageExists) {
      const errorMsg = `Timeout: Image ${ImageTag} not found in repository ${RepositoryName} after ${maxRetries} retries (${
        (maxRetries * retryDelay) / 1000 / 60
      } minutes)`;
      console.error(errorMsg);
      await sendResponse(
        event,
        context,
        "FAILED",
        {
          Message: errorMsg,
        },
        physicalId
      );
      return;
    }

    // Image exists, return success
    await sendResponse(
      event,
      context,
      "SUCCESS",
      {
        Message: `Image ${ImageTag} found in repository ${RepositoryName}`,
        RepositoryName,
        ImageTag,
      },
      physicalId
    );
  } catch (error) {
    // Error occurred - send failure response to CloudFormation
    await sendResponse(
      event,
      context,
      "FAILED",
      {
        Message: error.message || "Unknown error occurred",
      },
      PhysicalResourceId || "ecr-image-waiter-error"
    );
  }
};

/**
 * Sleep utility function
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send response to CloudFormation
 */
async function sendResponse(
  event,
  context,
  responseStatus,
  responseData,
  physicalResourceId
) {
  const responseBody = JSON.stringify({
    Status: responseStatus,
    Reason:
      responseData.Message ||
      `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: responseData,
  });

  console.log("Response body:", responseBody);

  const https = require("https");
  const url = require("url");

  const parsedUrl = url.parse(event.ResponseURL);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: "PUT",
    headers: {
      "content-type": "",
      "content-length": responseBody.length,
    },
  };

  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      console.log(`Status code: ${response.statusCode}`);
      console.log(`Status message: ${response.statusMessage}`);
      resolve();
    });

    request.on("error", (error) => {
      // Failed to send response to CloudFormation
      reject(error);
    });

    request.write(responseBody);
    request.end();
  });
}
