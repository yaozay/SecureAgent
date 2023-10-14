import { CodeSuggestion, Review } from "./constants";
import { Octokit } from "@octokit/rest";
import { WebhookEvent, WebhookEventMap } from "@octokit/webhooks-definitions/schema";


const postGeneralReviewComment = async (octokit: Octokit, payload: WebhookEventMap["pull_request"], review: string) => {
    try {
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            issue_number: payload.pull_request.number,
            body: review,
            headers: {
                "x-github-api-version": "2022-11-28",
            },
        });
    } catch (exc) {
        console.log(exc);
    }
}

const postInlineComment = async (octokit: Octokit, payload: WebhookEventMap["pull_request"], suggestion: CodeSuggestion) => {
    console.log(suggestion);
    try {
        const line = suggestion.line_end
        let startLine = null;
        if (suggestion.line_end != suggestion.line_start) {
            startLine = suggestion.line_start;
        }
        const suggestionBody = `\`\`\`suggestion\n${suggestion.correction}`;

        await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            pull_number: payload.pull_request.number,
            body: suggestionBody,
            commit_id: payload.pull_request.head.sha,
            path: suggestion.file,
            line: line,
            ...(startLine ? {start_line: startLine} : {}),
            // position: suggestion.line_start,
            // subject_type: "line",
            start_side: 'RIGHT',
            side: 'RIGHT',
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
    }  catch (exc) {
        console.log(exc);
    }
}

export const applyReview = async ({octokit, payload, review}: {octokit: Octokit, payload: WebhookEventMap["pull_request"], review: Review}) => {
    const commentPromise = postGeneralReviewComment(octokit, payload, review.review);
    const suggestionPromises = review.suggestions.map((suggestion) => postInlineComment(octokit, payload, suggestion));
    await Promise.all([
        commentPromise,
        ...suggestionPromises
    ]);
}