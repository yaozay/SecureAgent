import OpenAI from 'openai';
import { PR_SUGGESTION_TEMPLATE, buildPatchPrompt, buildSuggestionPrompt, constructPrompt, getModelTokenLimit, getReviewPrompt, getSuggestionPrompt, getTokenLength, getXMLReviewPrompt, isConversationWithinLimit, postProcessCodeSuggestions, withinModelTokenLimit } from './prompts';
import { BranchDetails, Builders, ChatMessage, CodeSuggestion, LLModel, PRFile, PRSuggestion } from './constants';
import { PullRequestEvent, WebhookEventMap } from '@octokit/webhooks-definitions/schema';
import { axiom } from './logger';
import { Octokit } from '@octokit/rest';
import { getGitFile } from './reviews';
import { AutoblocksTracer } from '@autoblocks/client';
import * as crypto from 'crypto';
import * as xml2js from "xml2js";

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
    // console.log(convo);
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

const processXMLSuggestions = async (feedbacks: string[]) => {
    const xmlParser = new xml2js.Parser();
    const parsedSuggestions = await Promise.all(
        feedbacks.map((fb) => {
            fb = fb.split('<code>').join('<code><![CDATA[').split('</code>').join(']]></code>');
            console.log(fb)
            return xmlParser.parseStringPromise(fb);
        })
    );
    // gets suggestion arrays [[suggestion], [suggestion]], then flattens
    const allSuggestions = parsedSuggestions.map((sug) => sug.review.suggestion).flat(1)
    const suggestions: PRSuggestion[] = allSuggestions.map(rawSuggestion => {
        const lines = rawSuggestion.code[0].trim().split("\n")
        lines[0] = lines[0].trim()
        lines[lines.length-1] = lines[lines.length-1].trim()
        const code = lines.join("\n")

        return {
            describe: rawSuggestion.describe[0],
            type: rawSuggestion.type[0],
            comment: rawSuggestion.comment[0],
            code: code,
            filename: rawSuggestion.filename[0]
        } as PRSuggestion;
    });
    return suggestions;
}

const convertPRSuggestionToComment = (suggestions: PRSuggestion[]) => {
    const suggestionsMap = new Map<string, PRSuggestion[]>();
    suggestions.forEach((suggestion) => {
        if (!suggestionsMap.has(suggestion.filename)) {
            suggestionsMap.set(suggestion.filename, []);
        }
        suggestionsMap.get(suggestion.filename).push(suggestion);
    });
    const comments: string[] = [];
    for (let [filename, suggestions] of suggestionsMap) {
        const temp = [`## ${filename}\n`];
        suggestions.forEach((suggestion: PRSuggestion) => {
            temp.push(PR_SUGGESTION_TEMPLATE.replace("{COMMENT}", suggestion.comment).replace("{CODE}", suggestion.code));
        });
        comments.push(temp.join("\n"));
    }
    return comments;
}

const xmlResponseBuilder = async (feedbacks: string[]) => {
    console.log("IN XML RESPONSE BUILDER");
    const parsedXMLSuggestions = await processXMLSuggestions(feedbacks);
    const comments = convertPRSuggestionToComment(parsedXMLSuggestions);
    return comments.join("\n")
}

const basicResponseBuilder = async (feedbacks: string[]) => {
    console.log("IN BASIC RESPONSE BUILDER");
    return feedbacks.join("\n");
}

export const reviewChanges = async (files: PRFile[], convoBuilder: (diff: string) => ChatMessage[], responseBuilder: (responses: string[]) => Promise<string>, model: LLModel = "gpt-3.5-turbo") => {
    const patchBuilder = buildPatchPrompt;
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
    try {
        return await responseBuilder(feedbacks);
    } catch (exc) {
        console.log("XML parsing error");
        console.log(exc);
        throw exc;
    }
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

const reviewChangesRetry = async (files: PRFile[], builders: Builders[], model: LLModel = "gpt-3.5-turbo") => {
    for (const {convoBuilder, responseBuilder} of builders) {
        try {
            console.log(`Trying with convoBuilder: ${convoBuilder.name}.`);
            return await reviewChanges(files, convoBuilder, responseBuilder, model);
        } catch (error) {
            console.log(`Error with convoBuilder: ${convoBuilder.name}, trying next one. Error: ${error}`);
        }
    }
    throw new Error('All convoBuilders failed.');
}

export const processPullRequest = async (octokit: Octokit, payload: WebhookEventMap["pull_request"], files: PRFile[], model: LLModel = "gpt-3.5-turbo", includeSuggestions = false) => {
    const filteredFiles = files.filter((file) => filterFile(file));
    if (filteredFiles.length == 0) {
        console.log("nothing to comment on")
        return {
            review: null,
            suggestions: []
        }
    }
    await Promise.all(filteredFiles.map((file) => {
        return preprocessFile(octokit, payload, file)
    }));
    if (includeSuggestions) {
        const [review, suggestions] = await Promise.all([
            reviewChangesRetry(filteredFiles, [
                {convoBuilder: getXMLReviewPrompt, responseBuilder: xmlResponseBuilder},
                {convoBuilder: getReviewPrompt, responseBuilder: basicResponseBuilder}
            ], model),
            generateCodeSuggestions(filteredFiles, model)
        ]);

        return {
            review,
            suggestions
        };
    } else {
        const [review] = await Promise.all([
            reviewChangesRetry(filteredFiles, [
                {convoBuilder: getXMLReviewPrompt, responseBuilder: xmlResponseBuilder},
                {convoBuilder: getReviewPrompt, responseBuilder: basicResponseBuilder}
            ], model),
        ]);

        return {
            review,
            suggestions: []
        };
    }
}