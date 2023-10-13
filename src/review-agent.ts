import OpenAI from 'openai';
import { buildPatchPrompt, constructPrompt, getModelTokenLimit, getReviewPrompt, getTokenLength, isConversationWithinLimit, withinModelTokenLimit } from './prompts';
import { LLModel, PRFile } from './constants';
import { PullRequestEvent } from '@octokit/webhooks-definitions/schema';
import { axiom } from './logger';

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

export const reviewDiff = async (diff: string, model: LLModel = "gpt-3.5-turbo") => {
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });
    const convo = getReviewPrompt(diff);
    console.log(convo);
    const chatCompletion = await openai.chat.completions.create({
        //@ts-ignore
        messages: convo,
        model: model,
    });
    console.log("done")
    return chatCompletion.choices[0].message.content;
}

export const reviewFiles = async (files: PRFile[], model: LLModel) => {
    const patches = files.map((file) => buildPatchPrompt(file));
    const diff = patches.join("\n");
    const feedback = await reviewDiff(diff, model);
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
const processWithinLimitFiles = (files: PRFile[], model: LLModel) => {
    const processGroups: PRFile[][] = [];
    const convoWithinModelLimit = isConversationWithinLimit(constructPrompt(files), model);

    console.log(`Within model token limits: ${convoWithinModelLimit}`);
    if (!convoWithinModelLimit) {
        const grouped = groupFilesByExtension(files);
        for (const [extension, filesForExt] of grouped.entries()) {
            const extGroupWithinModelLimit = isConversationWithinLimit(constructPrompt(filesForExt), model);
            if (extGroupWithinModelLimit) {
                processGroups.push(filesForExt);
            } else { // extension group exceeds model limit
                console.log('Processing files per extension that exceed model limit ...');
                let currentGroup: PRFile[] = [];
                filesForExt.sort((a, b) => a.patchTokenLength - b.patchTokenLength);
                filesForExt.forEach(file => {
                    const isPotentialGroupWithinLimit = isConversationWithinLimit(constructPrompt([...currentGroup, file]), model);
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
    const originalPatch = originalFile.patch;
    const strippedPatch = originalPatch.split('\n').filter(line => !line.startsWith('-')).join('\n');
    return { ...originalFile, patch: strippedPatch };
}

const processOutsideLimitFiles = (files: PRFile[], model: LLModel) => {
    const processGroups: PRFile[][] = [];
    if (files.length == 0) {
        return processGroups;
    }
    files = files.map((file) => stripRemovedLines(file));
    const convoWithinModelLimit = isConversationWithinLimit(constructPrompt(files), model);
    if (convoWithinModelLimit) {
        processGroups.push(files);
    } else {
        const exceedingLimits: PRFile[] = [];
        const withinLimits: PRFile[] = [];
        files.forEach((file) => {
            const isFileConvoWithinLimits = isConversationWithinLimit((constructPrompt([file])), model);
            if (isFileConvoWithinLimits) {
                withinLimits.push(file);
            } else {
                exceedingLimits.push(file);
            }
        });
        const withinLimitsGroup = processWithinLimitFiles(withinLimits, model);
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
    const filteredFiles = files.filter((file) => filterFile(file));
    filteredFiles.map((file) => {
        file.patchTokenLength = getTokenLength(buildPatchPrompt(file));
    });
    // further subdivide if necessary, maybe group files by common extension?
    const patchesWithinModelLimit: PRFile[] = [];
    // these single file patches are larger than the full model context
    const patchesOutsideModelLimit: PRFile[] = [];
    
    filteredFiles.forEach((file) => {
        const patchWithPromptWithinLimit = isConversationWithinLimit(constructPrompt([file]), model);
        if (patchWithPromptWithinLimit) {
            patchesWithinModelLimit.push(file);
        } else {
            patchesOutsideModelLimit.push(file);
        }
    });

    console.log(`files within limits: ${patchesWithinModelLimit.length}`);
    const withinLimitsPatchGroups = processWithinLimitFiles(patchesWithinModelLimit, model);
    const exceedingLimitsPatchGroups = processOutsideLimitFiles(patchesOutsideModelLimit, model);
    console.log(`${withinLimitsPatchGroups.length} within limits groups.`)
    console.log(`${patchesOutsideModelLimit.length} files outside limit, skipping them.`)

    const groups = [...withinLimitsPatchGroups, ...exceedingLimitsPatchGroups];

    const feedbacks = await Promise.all(
        groups.map((patchGroup) => {
            return reviewFiles(patchGroup, model);
        })
    );
    const review = feedbacks.join("\n");
    // console.log(review);
    return review;
}