import { BranchDetails, BuilderResponse, CodeSuggestion, Review, processGitFilepath } from "./constants";
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

    let commentPromise = null;
    const comment = review.review.comment;
    if (comment != null) {
        commentPromise = postGeneralReviewComment(octokit, payload, comment);
    }
    const suggestionPromises = review.suggestions.map((suggestion) => postInlineComment(octokit, payload, suggestion));
    await Promise.all([
        ...(commentPromise ? [commentPromise] : []),
        ...suggestionPromises
    ]);
}

const addLineNumbers = (contents: string) => {
    const rawContents = String.raw`${contents}`;
    const prepended = rawContents.split("\n").map((line, idx) => `${idx+1}: ${line}`).join("\n");
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
        if (exc.status === 404) {
            return {"content": null, "sha": null};
        }
        console.log(exc);
        throw exc;
    }
}

export const getFileContents = async (octokit: Octokit, payload: WebhookEventMap["issues"], branch: BranchDetails, filepath: string) => {
    const gitFile = await getGitFile(octokit, payload, branch, processGitFilepath(filepath));
    const fileWithLines = `# ${filepath}\n${addLineNumbers(gitFile.content)}`
    return { result : fileWithLines, functionString: `Opening file: ${filepath}` }
}

export const commentIssue = async (octokit: Octokit, payload: WebhookEventMap["issues"], comment: string) => {
    await octokit.rest.issues.createComment({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: payload.issue.number,
        body: comment
    });
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
        const branchComment = `Branch created: [${branchName}](${branchUrl})`;
        await commentIssue(octokit, payload, branchComment);

        console.log(`Branch ${branchName} created`);
    } catch (exc) {
        console.log(exc);
    }
    return branchDetails;
}

const overwriteFileLines = (contents: string, code: string, lineStart: number) => {
    let lines = contents.split('\n');
    const codeLines = code.split('\n').filter((line) => line.length > 0);
    lines.splice(lineStart <= 0 ? 0 : lineStart - 1, codeLines.length, ...codeLines);
    return lines;
}

const insertFileLines = (contents: string, code: string, lineStart: number) => {
    const lines = contents.split("\n");
    const codeLines = code.split("\n");
    lines.splice(lineStart <= 0 ? 0 : lineStart - 1, 0, ...codeLines);
    return lines;
}

export const editFileContents = async (octokit: Octokit, payload: WebhookEventMap["issues"], branch: BranchDetails, mode: string, filepath: string, code: string, lineStart: number) => {
    if (lineStart === undefined) {
        lineStart = 0;
    }
    try {
        let fileContent = await getGitFile(octokit, payload, branch, processGitFilepath(filepath))
        const rawContents = String.raw`${fileContent.content || ""}`;
        const rawCode = String.raw`${code}`;

        let updatedLines: string[] = [];
        if (mode == "insert") {
            updatedLines = insertFileLines(rawContents, rawCode, lineStart);
        } else if (mode == "overwrite") {
            updatedLines = overwriteFileLines(rawContents, rawCode, lineStart);
        } else {
            const err = `Unsupported file edit mode: ${mode}`;
            throw new Error(err);
        }
        const updatedContent = updatedLines.join('\n');
        const encodedContent = Buffer.from(updatedContent).toString('base64');

        // Commit the changes to the branch
        const commitResponse = await octokit.rest.repos.createOrUpdateFileContents({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            path: filepath,
            message: `Edit ${filepath}`,
            content: encodedContent,
            sha: fileContent.sha,
            branch: branch.name
        });

        console.log(`Edited file: ${filepath}`);

        // Get the diff between the current branch and the default branch
        const compareResponse = await octokit.rest.repos.compareCommits({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            base: payload.repository.default_branch,
            head: branch.name
        });

        // Filter the files to get the diff for the specific file
        const fileDiff = compareResponse.data.files.find(file => file.filename === filepath)?.patch;

        return { result: `Successfully edited file: ${filepath}`, functionString: `Editing file: ${filepath} with ${code}. Diff after commit:\n${fileDiff}`}
    } catch (exc) {
        console.log(exc);
    }
}
