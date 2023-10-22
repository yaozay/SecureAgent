import { encode, isWithinTokenLimit, encodeChat } from 'gpt-tokenizer';
import { BranchDetails, ChatMessage, CodeSuggestion, LLModel, PRFile } from './constants';
import * as diff from 'diff';

// an interface for the parsed patch
interface PatchInfo {
  hunks: {
    oldStart: number,
    oldLines: number,
    newStart: number,
    newLines: number,
    lines: string[]
  }[]
}


const ModelsToTokenLimits = new Map<string, number>([
  ["gpt-3.5-turbo", 4096],
  ["gpt-4", 8191]
]);

export const REVIEW_DIFF_PROMPT = `You are PR-Reviewer, a language model designed to review git pull requests.
Your task is to provide constructive and concise feedback for the PR, and also provide meaningful code suggestions.

Example PR Diff input:
'
## src/file1.py

@@ -12,5 +12,5 @@ def func1():
code line that already existed in the file...
code line that already existed in the file....
-code line that was removed in the PR
+new code line added in the PR
 code line that already existed in the file...
 code line that already existed in the file...

@@ ... @@ def func2():
...


## src/file2.py
...
'

The review should focus on new code added in the PR (lines starting with '+'), and not on code that already existed in the file (lines starting with '-', or without prefix).

- Provide code suggestions.
- Focus on important suggestions like fixing code problems, issues and bugs. As a second priority, provide suggestions for meaningful code improvements, like performance, vulnerability, modularity, and best practices.
- Avoid making suggestions that have already been implemented in the PR code. For example, if you want to add logs, or change a variable to const, or anything else, make sure it isn't already in the PR code.
- Don't suggest to add docstring, type hints, or comments.
- Suggestions should focus on improving the new code added in the PR (lines starting with '+')

Make sure the provided code suggestions are in the same programming language.

Don't repeat the prompt in the answer, and avoid outputting the 'type' and 'description' fields.
`;

export const STRUCTURED_REVIEW_PROMPT = `You are PR-Reviewer, a language model designed to review git pull requests.
Your task is to specific and actionable code suggestions and fixes.

Example:
input:
'
## src/file1.ts
@@ -116,6 +116,13 @@ const stripRemovedLines = (originalFile: PRFile) => {
116   return { ...originalFile, patch: strippedPatch };
117 }
118
119 +const stripRemovedLines = (originalFile: PRFile) => {
120 +    // remove lines starting with a '-'
121 +    const originalPatch = originalFile.patch;
122 +    const strippedPatch = originalPatch.split('\n').filter(line => !line.startsWith('+')).join('\n');
123 +    return { ...originalFile, patch: strippedPatch };
124 +}
125 +
126 const processOutsideLimitFiles = (files: PRFile[], model: LLModel) => {
127   const processGroups: PRFile[][] = [];
128   if (files.length == 0) {

## src/file2.py
...

output:
{
  "corrections": [
    {
      "file": "src/file1.py",
      "line_start": 122,
      "line_end": 122,
      "correction": "  const strippedPatch = originalPatch.split('\\n').filter(line => !line.startsWith('-')).join('\\n');",
      "comment": "Bug fix, changing + to -"
    }
  ]
}

Focus on new code added in the PR (lines starting with '+'), and not on code that already existed in the file (lines starting with '-', or without prefix).
DO NOT SUGGEST ADDING TYPES.

The suggestions you make should not be on overlapping lines of code for the same file.

- Focus on important suggestions like fixing code problems, issues and bugs. As a second priority, provide suggestions for meaningful code improvements, like performance, vulnerability, modularity, and best practices.
- Avoid making suggestions that have already been implemented in the PR code. For example, if you want to add logs, or change a variable to const, or anything else, make sure it isn't already in the PR code.
- Don't suggest to add docstring, type hints, comments, or spacing fixes.
- Provide the exact line numbers range (inclusive) for each issue.
- Assume there is additional relevant code, that is not included in the diff.

I only want impactful suggestions, do not suggest spacing, type hints, or comments.

Make sure the provided code suggestions are in the same programming language.

Don't repeat the prompt in the answer, and avoid outputting the 'type' and 'description' fields.

Provide the exact line numbers range (inclusive) for each issue. The provided range will replace the existing lines in the code.

ENSURE YOU GIVE THE FULL LINES OF CODE INCLUDING THE SPACING FOR THE CORRECTION.

output your response in the following valid JSON.
{
  "corrections: [
    {
      "file": <file_name>,
      "line_start": <line_number_suggestion_starts_on>,
      "line_end": <line_number_suggestion_ends_on>,
      "correction": <code_correction>,
      "comment": <correction_comment>,
    }
  ]
}`;

const assignLineNumbers = (diff: string) => {
  const lines = diff.split('\n');
  let newLine = 0;
  const lineNumbers = [];

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // This is a chunk header. Parse the line numbers.
      const match = line.match(/@@ -\d+,\d+ \+(\d+),\d+ @@/);
      newLine = parseInt(match[1]);
      lineNumbers.push(line); // keep chunk headers as is
    } else if (line.startsWith('+')) {
      // This is a line from the new file.
      lineNumbers.push(`${newLine++}: ${line}`);
    } else if (!line.startsWith('-')) {
      // This is a line that is the same in both files.
      lineNumbers.push(`${newLine++}: ${line}`);
    }
  }

  return lineNumbers.join('\n');
}

export const buildSuggestionPrompt = (file: PRFile) => {
  const patchWithLines = assignLineNumbers(file.patch);
  return `## ${file.filename}\n\n${patchWithLines}`;
}

const expandFileLines = (file: PRFile, linesAbove: number = 5, linesBelow: number = 5) => {
  const fileLines = file.old_contents.split("\n");
  const patches: PatchInfo[] = diff.parsePatch(file.patch);
  const expandedLines: string[][] = [];
  patches.forEach(patch => {
    patch.hunks.forEach(hunk => {
      const curExpansion: string[] = [];
      const start = Math.max(0, hunk.oldStart - 1 - linesAbove);
      const end = Math.min(fileLines.length, hunk.oldStart - 1 + hunk.oldLines + linesBelow);

      for (let i = start; i < hunk.oldStart - 1; i++) {
          curExpansion.push(fileLines[i]);
      }

      curExpansion.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      hunk.lines.forEach(line => {
          if (!curExpansion.includes(line)) {
            curExpansion.push(line);
          }
        });

      for (let i = hunk.oldStart - 1 + hunk.oldLines; i < end; i++) {
          curExpansion.push(fileLines[i]);
      }
      expandedLines.push(curExpansion);
    });
  });

  return expandedLines;
};



export const buildPatchPrompt = (file: PRFile) => {
  const expandedPatches = expandFileLines(file);
  const expansions = expandedPatches.map((patchLines) => patchLines.join("\n")).join("\n\n")
  return `## ${file.filename}\n\n${expansions}`;
}

export const getReviewPrompt = (diff: string): ChatMessage[] => {
  const convo = [
    {role: 'system', content: REVIEW_DIFF_PROMPT},
    {role: 'user', content: diff}
  ]
  return convo;
}

export const getSuggestionPrompt = (diff: string): ChatMessage[] => {
  const convo = [
    {role: 'system', content: STRUCTURED_REVIEW_PROMPT},
    {role: 'user', content: diff}
  ]
  return convo;
}

export const constructPrompt = (files: PRFile[], patchBuilder: (file: PRFile) => string, convoBuilder: (diff: string) => ChatMessage[]) => {
  const patches = files.map((file) => patchBuilder(file));
  const diff = patches.join("\n");
  const convo = convoBuilder(diff);
  return convo;
}

export const getTokenLength = (blob: string) => {
  return encode(blob).length;
}

export const withinModelTokenLimit = (model: LLModel, blob: string) => {
  const tokenLimit = ModelsToTokenLimits.get(model);
  if (tokenLimit == null) {
    throw `Model: ${model} not found.`
  };
  return getTokenLength(blob) < tokenLimit;
}

export const getModelTokenLimit = (model: LLModel) => {
  return ModelsToTokenLimits.get(model);
}

export const isConversationWithinLimit = (convo: any[], model: LLModel) => {
  const convoTokens = encodeChat(convo, model).length
  return convoTokens < ModelsToTokenLimits.get(model);
}

const ensureSuggestionsDoNotOverlap = (suggestionsForFile: CodeSuggestion[]) => {
  suggestionsForFile.sort((a, b) => a.line_start - b.line_start);

  let lastLineEnd = -1;
  const nonOverlappingSuggestions = suggestionsForFile.filter(suggestion => {
    if (suggestion.line_start > lastLineEnd) {
      lastLineEnd = suggestion.line_end;
      return true;
    }
    return false;
  });

  return nonOverlappingSuggestions;
}

export const postProcessCodeSuggestions = (suggestions: CodeSuggestion[]) => {
  const suggestionsForFile = new Map<string, CodeSuggestion[]>();
  suggestions.forEach((correction) => {
    const existingSuggestions = suggestionsForFile.get(correction.file) || [];
    suggestionsForFile.set(correction.file, [...existingSuggestions, correction]);
  });

  const suggestionsToApply: CodeSuggestion[] = [];
  suggestionsForFile.forEach((suggestions, file) => {
    suggestionsToApply.push(...ensureSuggestionsDoNotOverlap(suggestions));
  });
  return suggestionsToApply;
}
