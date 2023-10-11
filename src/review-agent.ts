import OpenAI from 'openai';
import { REVIEW_DIFF_PROMPT, getModelTokenLimit, getReviewPrompt, getTokenLength, withinModelTokenLimit } from './prompts';
import { LLModel, PRFile } from './constants';
import { encode } from 'gpt-tokenizer';

const buildPatchPrompt = (file: PRFile) => {
    return `## ${file.filename}\n\n${file.patch}`;
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
    const filesToIgnore = new Set<string>(["package-lock.json"]);
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


// todo: include prompt tokens
const processWithinLimitFiles = (files: PRFile[], model: LLModel) => {
    const processGroups: PRFile[][] = [];
    const fullTokenCount = files.reduce((total, file) => total + (file.patchTokenLength || 0), 0) + encode(REVIEW_DIFF_PROMPT).length;

    const tokenLimit = getModelTokenLimit(model);
    console.log(`model limit: ${tokenLimit}\ntoken count: ${fullTokenCount}`);
    if (fullTokenCount > tokenLimit) {
        const grouped = groupFilesByExtension(files);
        for (const [extension, filesForExt] of grouped.entries()) {
            const extTokenCount = filesForExt.reduce((total, file) => total + (file.patchTokenLength || 0), 0) + encode(REVIEW_DIFF_PROMPT).length;
            if (extTokenCount < tokenLimit) {
                processGroups.push(filesForExt);
            } else {
                // more processing
                console.log('Split by extension still exceeds model limit, need more token optimization.');
            }
        }
    } else {
        processGroups.push(files);
    }
    return processGroups;
}

const processOutsideLimitFiles = (files: PRFile[], model: LLModel) => {
    // remove lines starting with a '-'?
    throw "Unimplemented";
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
        if (withinModelTokenLimit(model, file.patch)) {
            patchesWithinModelLimit.push(file);
        } else {
            patchesOutsideModelLimit.push(file);
        }
    });

    console.log(`files within limits: ${patchesWithinModelLimit.length}`);
    const withinLimitsPatchGroups = processWithinLimitFiles(patchesWithinModelLimit, model);
    console.log(`${withinLimitsPatchGroups.length} within limits groups.`)
    console.log(`${patchesOutsideModelLimit.length} files outside limit, skipping them.`)


    const feedbacks = await Promise.all(
        withinLimitsPatchGroups.map((patchGroup) => {
            return reviewFiles(patchGroup, model);
        })
    );
    const review = feedbacks.join("\n");
    return review;
}