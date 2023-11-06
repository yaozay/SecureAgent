import { Node } from "@babel/traverse";

export type LLModel = "gpt-3.5-turbo" | "gpt-4";

export interface PRFile {
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
    old_contents?: string;
    current_contents?: string;
};

export interface BuilderResponse {
    comment: string;
    structuredComments: any[]
}

export interface Builders {
    convoBuilder: (diff: string) => ChatMessage[];
    responseBuilder: (feedbacks: string[]) => Promise<BuilderResponse>;
}

export interface PatchInfo {
    hunks: {
      oldStart: number,
      oldLines: number,
      newStart: number,
      newLines: number,
      lines: string[]
    }[]
}

export interface PRSuggestion {
    describe: string;
    type: string;
    comment: string;
    code: string;
    filename: string;
}

export interface CodeSuggestion {
    file: string;
    line_start: number;
    line_end: number;
    correction: string;
    comment: string;
}

export interface ChatMessage {
    role: string;
    content: string;
}

export interface Review {
    review: BuilderResponse;
    suggestions: CodeSuggestion[];
}

export interface BranchDetails {
    name: string;
    sha: string;
    url: string;
};

export const sleep = async (ms: number) => {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export const processGitFilepath = (filepath: string) => {
    // Remove the leading '/' if it exists
    return filepath.startsWith('/') ? filepath.slice(1) : filepath;
}

export interface EnclosingContext {
    enclosingContext: Node | null;
}

export interface AbstractParser {
    findEnclosingContext(file: string, lineStart: number, lineEnd: number): EnclosingContext;
}
