import OpenAI from 'openai';
import { getReviewPrompt, getTokenLength, withinModelTokenLimit } from './prompts';

interface PRFile {
    sha: string;
    filename: string;
    status: "added" | "removed" | "renamed" | "changed" | "modified" | "copied" | "unchanged";
    additions: number;
    deletions: number;
    changes: number;
    blob_url: string;
    raw_url: string;
    contents_url: string;
    patch?: string;
    previous_filename?: string;
    patchTokenLength?: number;
}

export const reviewDiff = async (diff: string, model = "gpt-3.5-turbo") => {
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

export const reviewChanges = async (files: PRFile[], model = "gpt-3.5-turbo") => {
    const filteredFiles = files.filter((file) => filterFile(file));
    filteredFiles.map((file) => {
        file.patchTokenLength = getTokenLength(file.patch);
    });
    // further subdivide if necessary, maybe group files by common extension?
    const patchesWithinModelLimit = filteredFiles.filter((file) => withinModelTokenLimit(model, file.patch));
    // these single file patches are larger than the full model context
    const patchesOutsideModelLimit = filteredFiles.filter((file) => !withinModelTokenLimit(model, file.patch));

    

    const patches = filteredFiles.map((file) => file.patch);
    const diff = patches.join("\n");

    const feedback = await reviewDiff(diff, "gpt-4");
    return feedback;
}