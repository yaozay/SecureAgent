import * as dotenv from "dotenv";
dotenv.config();
import { App } from "octokit";
import { createNodeMiddleware } from "@octokit/webhooks";
import * as http from "http";
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import { logPRInfo, processPullRequest, reviewChanges, reviewDiff } from "./review-agent";
import { applyReview } from "./reviews";
import { Review } from "./constants";

const devEnv = process.env.NODE_ENV != "production";
console.log(devEnv);

const appId = devEnv ? process.env.DEV_APP_ID : process.env.APP_ID;
const webhookSecret = devEnv ? process.env.DEV_WEBHOOK_SECRET : process.env.WEBHOOK_SECRET;

// This reads the contents of your private key file.
const privateKey = Buffer.from(devEnv ? process.env.DEV_PRIVATE_KEY : process.env.PRIVATE_KEY, 'base64').toString('utf-8');

// This creates a new instance of the Octokit App class.
const reviewApp = new App({
  appId: appId,
  privateKey: privateKey,
  webhooks: {
    secret: webhookSecret
  },
});

const getChangesPerFile = async (payload: WebhookEventMap["pull_request"]) => {
  try {
    const { data: files } = await (await reviewApp.getInstallationOctokit(payload.installation.id)).rest.pulls.listFiles({
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
  // const reposWithInlineEnabled = new Set<number>([601904706, 701925328]);
  // const canInlineSuggest = reposWithInlineEnabled.has(payload.repository.id);
  try {
    // logPRInfo(payload);
    // const files = await getChangesPerFile(payload);
    // const review: Review = await processPullRequest(octokit, payload, files, "gpt-4", true);
    // await applyReview({octokit, payload, review})
    // console.log("Review Submitted");
  } catch (exc) {
    console.log(exc);
  }
};

// This sets up a webhook event listener. When your app receives a webhook event from GitHub with a `X-GitHub-Event` header value of `pull_request` and an `action` payload value of `opened`, it calls the `handlePullRequestOpened` event handler that is defined above.
//@ts-ignore
reviewApp.webhooks.on("pull_request.opened", handlePullRequestOpened);


const port = process.env.PORT || 3000;
const reviewWebhook = `/api/review`;

const reviewMiddleware = createNodeMiddleware(reviewApp.webhooks, {path: "/api/review"});

const server = http.createServer((req, res) => {
  if (req.url === reviewWebhook) {
    reviewMiddleware(req, res);
  } else {
    res.statusCode = 404;
    res.end();
  }
});


// This creates a Node.js server that listens for incoming HTTP requests (including webhook payloads from GitHub) on the specified port. When the server receives a request, it executes the `middleware` function that you defined earlier. Once the server is running, it logs messages to the console to indicate that it is listening.
server.listen(port, () => {
  console.log(`Server is listening for events.`);
  console.log('Press Ctrl + C to quit.')
});