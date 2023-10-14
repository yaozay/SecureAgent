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
};

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
    review: string,
    suggestions: CodeSuggestion[]
}
