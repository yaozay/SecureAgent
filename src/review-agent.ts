import OpenAI from 'openai';
import { buildPatchPrompt, buildSuggestionPrompt, constructPrompt, getModelTokenLimit, getReviewPrompt, getSuggestionPrompt, getTokenLength, isConversationWithinLimit, postProcessCodeSuggestions, withinModelTokenLimit } from './prompts';
import { BranchDetails, ChatMessage, CodeSuggestion, LLModel, PRFile } from './constants';
import { PullRequestEvent, WebhookEventMap } from '@octokit/webhooks-definitions/schema';
import { axiom } from './logger';
import { Octokit } from '@octokit/rest';
import { getGitFile } from './reviews';
import { AutoblocksTracer } from '@autoblocks/client';
import * as crypto from 'crypto';

interface PRLogEvent {
    id: number;
    fullName: string;
    url: string;
};

export const logPRInfo = (pullRequest: PullRequestEvent) => {
    const logEvent: PRLogEvent = {
        id: pullRequest.repository.id,
        fullName: pullRequest.repository.full_name,
        url: pullRequest.repository.html_url,
    }
    axiom.ingest('review-agent', [logEvent]);
    return logEvent;
}

export const reviewDiff = async (convo: ChatMessage[], model: LLModel = "gpt-3.5-turbo") => {
    const tracer = new AutoblocksTracer(process.env.AUTOBLOCKS_INGESTION_KEY, {
        traceId: crypto.randomUUID(),
        properties: {
            provider: 'openai',
        },
    });
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    const requestParams = {  
        messages: convo,
        model: model,
        temperature: 0
    };
    await tracer.sendEvent('review-agent.request', {
        properties: requestParams,
    });
    console.log(convo);
    try {
        //@ts-ignore
        const chatCompletion = await openai.chat.completions.create(requestParams);
        await tracer.sendEvent('review-agent.response', {
            properties: {
                response: chatCompletion
            },
        });
        return chatCompletion.choices[0].message.content;
    } catch (exc) {
        console.log(exc);
        await tracer.sendEvent('review-agent.error', {
            properties: {
                exc,
            },
        });
        throw new Error("Error getting LLM response")
    }
    
}

export const reviewFiles = async (files: PRFile[], model: LLModel, patchBuilder: (file: PRFile) => string, convoBuilder: (diff: string) => ChatMessage[]) => {
    const patches = files.map((file) => patchBuilder(file));
    const convo = convoBuilder(patches.join("\n"));
    const feedback = await reviewDiff(convo, model);
    return feedback
}

const filterFile = (file: PRFile) => {
    const extensionsToIgnore = new Set<string>(["pdf", "png", "jpg", "jpeg", "gif", "mp4", "mp3"])
    const filesToIgnore = new Set<string>(["package-lock.json", "yarn.lock"]);
    if (filesToIgnore.has(file.filename)) {
        return false;
    }
    const extension = file.filename.split('.').pop()?.toLowerCase();
    if (extension && extensionsToIgnore.has(extension)) {
        return false;
    }

    return true;
}

const groupFilesByExtension = (files: PRFile[]): Map<string, PRFile[]> => {
    const filesByExtension: Map<string, PRFile[]> = new Map();

    files.forEach((file) => {
        const extension = file.filename.split('.').pop()?.toLowerCase();
        if (extension) {
            if (!filesByExtension.has(extension)) {
                filesByExtension.set(extension, []);
            }
            filesByExtension.get(extension)?.push(file);
        }
    });

    return filesByExtension;
}


// all of the files here can be processed with the prompt at minimum
const processWithinLimitFiles = (files: PRFile[], model: LLModel, patchBuilder: (file: PRFile) => string, convoBuilder: (diff: string) => ChatMessage[]) => {
    const processGroups: PRFile[][] = [];
    const convoWithinModelLimit = isConversationWithinLimit(constructPrompt(files, patchBuilder, convoBuilder), model);

    console.log(`Within model token limits: ${convoWithinModelLimit}`);
    if (!convoWithinModelLimit) {
        const grouped = groupFilesByExtension(files);
        for (const [extension, filesForExt] of grouped.entries()) {
            const extGroupWithinModelLimit = isConversationWithinLimit(constructPrompt(filesForExt, patchBuilder, convoBuilder), model);
            if (extGroupWithinModelLimit) {
                processGroups.push(filesForExt);
            } else { // extension group exceeds model limit
                console.log('Processing files per extension that exceed model limit ...');
                let currentGroup: PRFile[] = [];
                filesForExt.sort((a, b) => a.patchTokenLength - b.patchTokenLength);
                filesForExt.forEach(file => {
                    const isPotentialGroupWithinLimit = isConversationWithinLimit(constructPrompt([...currentGroup, file], patchBuilder, convoBuilder), model);
                    if (isPotentialGroupWithinLimit) {
                        currentGroup.push(file);
                    } else {
                        processGroups.push(currentGroup);
                        currentGroup = [file];
                    }
                });
                if (currentGroup.length > 0) {
                    processGroups.push(currentGroup);
                }
            }
        }
    } else {
        processGroups.push(files);
    }
    return processGroups;
}

const stripRemovedLines = (originalFile: PRFile) => {
    // remove lines starting with a '-'
    const originalPatch = String.raw`${originalFile.patch}`;
    const strippedPatch = originalPatch.split('\n').filter(line => !line.startsWith('-')).join('\n');
    return { ...originalFile, patch: strippedPatch };
}

const processOutsideLimitFiles = (files: PRFile[], model: LLModel, patchBuilder: (file: PRFile) => string, convoBuilder: (diff: string) => ChatMessage[]) => {
    const processGroups: PRFile[][] = [];
    if (files.length == 0) {
        return processGroups;
    }
    files = files.map((file) => stripRemovedLines(file));
    const convoWithinModelLimit = isConversationWithinLimit(constructPrompt(files, patchBuilder, convoBuilder), model);
    if (convoWithinModelLimit) {
        processGroups.push(files);
    } else {
        const exceedingLimits: PRFile[] = [];
        const withinLimits: PRFile[] = [];
        files.forEach((file) => {
            const isFileConvoWithinLimits = isConversationWithinLimit(constructPrompt([file], patchBuilder, convoBuilder), model);
            if (isFileConvoWithinLimits) {
                withinLimits.push(file);
            } else {
                exceedingLimits.push(file);
            }
        });
        const withinLimitsGroup = processWithinLimitFiles(withinLimits, model, patchBuilder, convoBuilder);
        withinLimitsGroup.forEach((group) => {
            processGroups.push(group);
        });
        if (exceedingLimits.length > 0) {
            console.log("TODO: Need to further chunk large file changes.");
            // throw "Unimplemented"
        }
    }
    return processGroups;
}

export const reviewChanges = async (files: PRFile[], model: LLModel = "gpt-3.5-turbo") => {
    const patchBuilder = buildPatchPrompt;
    const convoBuilder = getReviewPrompt;
    const filteredFiles = files.filter((file) => filterFile(file));
    filteredFiles.map((file) => {
        file.patchTokenLength = getTokenLength(patchBuilder(file));
    });
    // further subdivide if necessary, maybe group files by common extension?
    const patchesWithinModelLimit: PRFile[] = [];
    // these single file patches are larger than the full model context
    const patchesOutsideModelLimit: PRFile[] = [];
    
    filteredFiles.forEach((file) => {
        const patchWithPromptWithinLimit = isConversationWithinLimit(constructPrompt([file], patchBuilder, convoBuilder), model);
        if (patchWithPromptWithinLimit) {
            patchesWithinModelLimit.push(file);
        } else {
            patchesOutsideModelLimit.push(file);
        }
    });

    console.log(`files within limits: ${patchesWithinModelLimit.length}`);
    const withinLimitsPatchGroups = processWithinLimitFiles(patchesWithinModelLimit, model, patchBuilder, convoBuilder);
    const exceedingLimitsPatchGroups = processOutsideLimitFiles(patchesOutsideModelLimit, model, patchBuilder, convoBuilder);
    console.log(`${withinLimitsPatchGroups.length} within limits groups.`)
    console.log(`${patchesOutsideModelLimit.length} files outside limit, skipping them.`)

    const groups = [...withinLimitsPatchGroups, ...exceedingLimitsPatchGroups];

    const feedbacks = await Promise.all(
        groups.map((patchGroup) => {
            return reviewFiles(patchGroup, model, patchBuilder, convoBuilder);
        })
    );
    const review = feedbacks.join("\n");
    console.log(review);
    return review;
}

export const generateCodeSuggestions = async (files: PRFile[], model: LLModel = "gpt-3.5-turbo") => {
    const patchBuilder = buildSuggestionPrompt;
    const convoBuilder = getSuggestionPrompt;
    const filteredFiles = files.filter((file) => filterFile(file));
    filteredFiles.map((file) => {
        file.patchTokenLength = getTokenLength(patchBuilder(file));
    });
    // further subdivide if necessary, maybe group files by common extension?
    const patchesWithinModelLimit: PRFile[] = [];
    // these single file patches are larger than the full model context
    const patchesOutsideModelLimit: PRFile[] = [];
    
    filteredFiles.forEach((file) => {
        const patchWithPromptWithinLimit = isConversationWithinLimit(constructPrompt([file], patchBuilder, convoBuilder), model);
        if (patchWithPromptWithinLimit) {
            patchesWithinModelLimit.push(file);
        } else {
            patchesOutsideModelLimit.push(file);
        }
    });
    try {
        console.log(`files within limits: ${patchesWithinModelLimit.length}`);
        const withinLimitsPatchGroups = processWithinLimitFiles(patchesWithinModelLimit, model, patchBuilder, convoBuilder);
        const exceedingLimitsPatchGroups = processOutsideLimitFiles(patchesOutsideModelLimit, model, patchBuilder, convoBuilder);
        console.log(`${withinLimitsPatchGroups.length} within limits groups.`)
        console.log(`${patchesOutsideModelLimit.length} files outside limit, skipping them.`)

        const groups = [...withinLimitsPatchGroups, ...exceedingLimitsPatchGroups];

        const suggestions = await Promise.all(
            groups.map((patchGroup) => {
                return reviewFiles(patchGroup, model, patchBuilder, convoBuilder);
            })
        );
        const codeSuggestions = suggestions.map((suggestion) => JSON.parse(suggestion)["corrections"]).flat(1);
        const postProcess = postProcessCodeSuggestions(codeSuggestions);
        return postProcess;
    } catch (exc) {
        console.log(exc);
        return [];
    }
}

const preprocessFile = async (octokit: Octokit, payload: WebhookEventMap["pull_request"], file: PRFile) => {
    const branch: BranchDetails = {
        name: payload.pull_request.base.ref,
        sha: payload.pull_request.base.sha,
        url: payload.pull_request.url
    };
    // Handle scenario where file does not exist!!
    const contents = await getGitFile(octokit, payload, branch, file.filename);
    if (contents.content == null) {
        console.log(`New File: ${file.filename}`)
        file.old_contents = null
    } else {
        file.old_contents = String.raw`${contents.content}`;
    }
}

export const processPullRequest = async (octokit: Octokit, payload: WebhookEventMap["pull_request"], files: PRFile[], model: LLModel = "gpt-3.5-turbo", includeSuggestions = false) => {
    await Promise.all(files.map((file) => {
        return preprocessFile(octokit, payload, file)
    }));
    if (includeSuggestions) {
        const [review, suggestions] = await Promise.all([
            reviewChanges(files, model),
            generateCodeSuggestions(files, model)
        ]);

        return {
            review,
            suggestions
        };
    } else {
        const [review] = await Promise.all([
            reviewChanges(files, model),
        ]);

        return {
            review,
            suggestions: []
        };
    }
}