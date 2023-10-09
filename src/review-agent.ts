import OpenAI from 'openai';
import { getReviewPrompt } from './prompts';

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
}

export const reviewDiff = async (diff: string, model = "gpt-3.5-turbo") => {
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });
    console.log(diff);
    const convo = getReviewPrompt(diff);
    const chatCompletion = await openai.chat.completions.create({
        //@ts-ignore
        messages: convo,
        model: model,
    });
    console.log("done")
    return chatCompletion.choices[0].message.content;
}

const filterFile = (file: PRFile) => {
    const filesToIgnore = new Set<string>(["package-lock.json"]);
    if (filesToIgnore.has(file.filename)) {
        return false;
    }
    return true;
}

export const reviewChanges = async (files: PRFile[]) => {
    const filteredFiles = files.filter((file) => filterFile(file));
    const patches = filteredFiles.map((file) => file.patch);
    const diff = patches.join("\n");

    const feedback = await reviewDiff(diff, "gpt-4");
    return feedback;
}