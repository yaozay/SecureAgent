# AI Review Agent

This is a GitHub App that reviews pull requests and submits reviews with AI.

## Setup

1. Download NGROK [here](https://download.ngrok.com/). This will be used to create a secure tunnel to your local server.

2. Run NGROK in your terminal with the following command:

```
ngrok http 3000
```

Here you'll see a URL in the format of `https://<random>.ngrok.app`. Make sure to save this URL as you'll need it to configure your GitHub App.

3. Create a new [GitHub App here](https://github.com/settings/apps)
- Make sure to paste the NGROK URL (e.g. ```https://4836-204-48-36-234.ngrok-free.app```) as the "Webhook URL"
- Create a webhook secret, this can be anything and then paste it in the "secret" field when setting up the GitHub app
- Make sure to grant the app the read & write permissions for the following:
  - Pull Requests
  - Repository Contents
  - Issues
  - Commit Statuses
  - Webhooks
- Subscribe to the following events:
  - Pull Request
  - Pull Request Review
  - Pull Request Review Comment
  - Pull Request Comment Thread
  - Commit Comment

- Download your private key - this will be used later on to authenticate your app

- Install your GitHub app to all of your repositories

4. Clone the repo

```
git clone https://github.com/CoderAgent/SecureAgent
cd SecureAgent
```

5. Install dependencies
```
npm install
```

6. Get your Groq API key [here](https://console.groq.com/keys). Through Groq, you'll have free access to the Llama and Gemini models.

7. Create an account on [Axiom](https://app.axiom.co/) and get your API key and org ID. Axiom is used for logging.

8. Create a `.env` file with the following variables:
```
DEV_PRIVATE_KEY=<your-private-key>
DEV_APP_ID=<your-app-id>
DEV_WEBHOOK_SECRET=<your-webhook-secret>
GROQ_API_KEY=<your-groq-api-key>
AXIOM_API_KEY=<your-axiom-api-key>
AXIOM_ORG_ID=<your-axiom-org-id>
```

9. Go to a GitHub repository that you have access to set up your webhook.
In the repository, go to `Settings > Webhooks > Add webhook`.

For the payload URL, use your NGROK URL + `/api/review`. For example:
 ```https://4836-204-48-36-234.ngrok-free.app/api/review```

For content type, select `application/json`.

For secret, use the webhook secret you created when setting up your GitHub app.

Leave the rest of the fields unchanged and click `Add webhook`.

10. In the `chat.ts` file, change this code:
```
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
```
to this:
```
const openai = new OpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
});
```

In the `review-agent.ts` file, change this code:
```
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
```
to this:
```
const openai = new OpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
});
```

- Make sure to change all instances of "gpt-4" or "gpt-3.5-turbo" to the model you want to use from Groq. For example, you can use:

- `llama-3.1-8b-instant`
- `llama-3.2-70b-versatile`
- `llama-3.2-90b-vision-preview`

Check out all supported models [here](https://console.groq.com/docs/models).

11. Within the `SecureAgent` directory in your IDE, run the code with the following command:
```
npm install -g ts-node
ts-node src/app.ts
```

12. Create a pull request on your repository and watch the review agent submit a review! 