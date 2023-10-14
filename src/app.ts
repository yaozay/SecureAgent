import * as dotenv from "dotenv";
dotenv.config();
import { App } from "octokit";
import { createNodeMiddleware } from "@octokit/webhooks";
import * as http from "http";
import { Octokit } from "@octokit/rest";
import { WebhookEvent, WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import { generateCodeSuggestions, logPRInfo, processPullRequest, reviewChanges, reviewDiff } from "./review-agent";
import { applyReview } from "./reviews";
import { Review } from "./constants";


// This reads your `.env` file and adds the variables from that file to the `process.env` object in Node.js.

// This assigns the values of your environment variables to local variables.

const devEnv = process.env.NODE_ENV != "production";
console.log(devEnv);

const appId = devEnv ? process.env.DEV_APP_ID : process.env.APP_ID;
const webhookSecret = devEnv ? process.env.DEV_WEBHOOK_SECRET : process.env.WEBHOOK_SECRET;

// This reads the contents of your private key file.
const privateKey = Buffer.from(devEnv ? process.env.DEV_PRIVATE_KEY : process.env.PRIVATE_KEY, 'base64').toString('utf-8');

// This creates a new instance of the Octokit App class.
const app = new App({
  appId: appId,
  privateKey: privateKey,
  webhooks: {
    secret: webhookSecret
  },
});

// This defines the message that your app will post to pull requests.
const messageForNewPRs = "Thanks for opening a new PR! Please follow our contributing guidelines to make your PR easier to review.";

const getChangesPerFile = async (payload: WebhookEventMap["pull_request"]) => {
  try {
    const { data: files } = await (await app.getInstallationOctokit(payload.installation.id)).rest.pulls.listFiles({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: payload.pull_request.number
    });
    return files;
  } catch (exc) {
    console.log("exc");
    return [];
  }
}

// This adds an event handler that your code will call later. When this event handler is called, it will log the event to the console. Then, it will use GitHub's REST API to add a comment to the pull request that triggered the event.
async function handlePullRequestOpened({octokit, payload}: {octokit: Octokit, payload: WebhookEventMap["pull_request"]}) {
  console.log(`Received a pull request event for #${payload.pull_request.number}`);

  try {
    logPRInfo(payload);
    const files = await getChangesPerFile(payload);
    const review: Review = await processPullRequest(files, "gpt-4");
    await applyReview({octokit, payload, review})
    console.log("Review Submitted");
  } catch (exc) {
    console.log(exc);
  }
};

// This sets up a webhook event listener. When your app receives a webhook event from GitHub with a `X-GitHub-Event` header value of `pull_request` and an `action` payload value of `opened`, it calls the `handlePullRequestOpened` event handler that is defined above.
//@ts-ignore
app.webhooks.on("pull_request.opened", handlePullRequestOpened);

// This logs any errors that occur.
app.webhooks.onError((error) => {
  if (error.name === "AggregateError") {
    console.error(`Error processing request: ${error.event}`);
  } else {
    console.error(error);
  }
});

const port = process.env.PORT || 3000;
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';


const path = "/api/webhook";
const localWebhookUrl = `http://${host}:${port}${path}`;

// This sets up a middleware function to handle incoming webhook events.
//
// Octokit's `createNodeMiddleware` function takes care of generating this middleware function for you. The resulting middleware function will:
//
//    - Check the signature of the incoming webhook event to make sure that it matches your webhook secret. This verifies that the incoming webhook event is a valid GitHub event.
//    - Parse the webhook event payload and identify the type of event.
//    - Trigger the corresponding webhook event handler.
const middleware = createNodeMiddleware(app.webhooks, {path});

// This creates a Node.js server that listens for incoming HTTP requests (including webhook payloads from GitHub) on the specified port. When the server receives a request, it executes the `middleware` function that you defined earlier. Once the server is running, it logs messages to the console to indicate that it is listening.
http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for events at: ${localWebhookUrl}`);
  console.log('Press Ctrl + C to quit.')
});
