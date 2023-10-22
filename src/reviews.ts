import { BranchDetails, CodeSuggestion, Review, processGitFilepath } from "./constants";
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";


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

const addLineNumbers = (contents: string) => {
    const prepended = String.raw`${contents}`.split("\n").map((line, idx) => `${idx+1}: ${line}`).join("\n");
    return prepended;
}

export const getGitFile = async (octokit: Octokit, payload: WebhookEventMap["issues"] | WebhookEventMap["pull_request"], branch: BranchDetails, filepath: string) => {
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            path: filepath,
            ref: branch.name, // specify the branch name here
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
        //@ts-ignore
        const decodedContent = Buffer.from(response.data.content, 'base64').toString('utf8');
        //@ts-ignore
        return {"content": decodedContent, "sha": response.data.sha};
    } catch (exc) {
        console.log(exc);
    }
}

export const getFileContents = async (octokit: Octokit, payload: WebhookEventMap["issues"], branch: BranchDetails, filepath: string) => {
    const gitFile = await getGitFile(octokit, payload, branch, processGitFilepath(filepath));
    return addLineNumbers(gitFile.content);
}

export const createBranch = async (octokit: Octokit, payload: WebhookEventMap["issues"]) => {
    let branchDetails = null;
    try {
        const title = payload.issue.title.replace(/\s/g, "-").substring(0, 15);

        const hash = Math.random().toString(36).substring(2, 7);
        const subName = `${title}-${hash}`.substring(0, 20);
        const branchName = `Code-Bot/${subName}`
        // Get the default branch for the repository
        const { data: repo } = await octokit.rest.repos.get({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
        });

        // Get the commit SHA of the default branch
        const { data: ref } = await octokit.rest.git.getRef({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            ref: `heads/${repo.default_branch}`,
        });

        // Create a new branch from the commit SHA
        const { data: newBranch } = await octokit.rest.git.createRef({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            ref: `refs/heads/${branchName}`,
            sha: ref.object.sha,
        });

        console.log(newBranch);

        branchDetails = {
            name: branchName,
            sha: newBranch.object.sha,
            url: newBranch.url
        };
        let branchUrl = `https://github.com/${payload.repository.owner.login}/${payload.repository.name}/tree/${branchName}`;

        await octokit.rest.issues.createComment({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            issue_number: payload.issue.number,
            body: `Branch created: [${branchName}](${branchUrl})`
        });

        console.log(`Branch ${branchName} created`);
    } catch (exc) {
        console.log(exc);
    }
    return branchDetails;
}

export const editFileContents = async (octokit: Octokit, payload: WebhookEventMap["issues"], branch: BranchDetails, filepath: string, code: string, lineStart: number, lineEnd: number) => {
    try {
        let fileContent = await getGitFile(octokit, payload, branch, processGitFilepath(filepath))

        let lines = String.raw`${fileContent.content}`.split('\n');
        const codeLines = String.raw`${code}`.split('\n').filter((line) => line.length > 0);
        lines.splice(lineStart <= 0 ? 0 : lineStart - 1, codeLines.length, code);
        const updatedContent = lines.join('\n');

        const encodedContent = Buffer.from(updatedContent).toString('base64');

        // Commit the changes to the branch
        await octokit.rest.repos.createOrUpdateFileContents({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            path: filepath,
            message: `Edit ${filepath}`,
            content: encodedContent,
            sha: fileContent.sha,
            branch: branch.name
        });

        console.log(`Edited file: ${filepath}`);
        return `Edited file: ${filepath}`;
    } catch (exc) {
        console.log(exc);
    }
}
