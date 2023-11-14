import { encode, encodeChat } from 'gpt-tokenizer';
import { ChatMessage, CodeSuggestion, LLModel, PRFile } from './constants';
import { smarterContextPatchStrategy, rawPatchStrategy } from './context/review';

const ModelsToTokenLimits = new Map<string, number>([
  ["gpt-3.5-turbo", 4096],
  ["gpt-4", 7200]
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

- ONLY PROVIDE CODE SUGGESTIONS
- Focus on important suggestions like fixing code problems, improving performance, improving security, improving readability
- Avoid making suggestions that have already been implemented in the PR code. For example, if you want to add logs, or change a variable to const, or anything else, make sure it isn't already in the PR code.
- Don't suggest adding docstring, type hints, or comments.
- Suggestions should focus on improving the new code added in the PR (lines starting with '+')
- Do not say things like without seeing the full repo, or full code, or rest of the codebase. Comment only on the code you have!

Make sure the provided code suggestions are in the same programming language.

Don't repeat the prompt in the answer, and avoid outputting the 'type' and 'description' fields.

Think through your suggestions and make exceptional improvements.`;

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

export const XML_PR_REVIEW_PROMPT = `You are an expert pull request reviewer.
You will be given several files with changed lines.

Make sure your code enhance recommendations are appropriate for the programming language in the PR and avoid unnecessary repetition. Thoughtfully shaped suggestions should be proposed to enhance performance, security, readability, etc.

Render these recommendations in XML format using the tags: <review>, <code>, <suggestion>, <comment>, <correct>, <implemented>, <type>, <describe>, <filename>. Multiple recommendations can be provided but all should be within one <review> tag.

Please adhere to the valid Markdown syntax for GitHub when making code suggestions, identifying the language the code is written in, and ensure they are enclosed within backticks (\`\`\`). Don't shy away from giving multiple relevant suggestions in the pursuit of genuinely improving the code\'s effectiveness.

Example output:
<review>
  <suggestion>
    <describe>[Objective of the newly incorporated code & why this is an improvement]</describe>
    <type>[Category of the given suggestion such as performance, security, etc.]</type>
    <comment>[Guidance on improving the new code]</comment>
    <code>
    \`\`\`[Programming Language]
    [Equivalent code amendment in the same language]
    \`\`\`
    </code>
   <correct>[true | false] if the suggestion is correct</correct>
   <implemented>[true | false] if the suggestion has already been implemented in the code or diff</implemented>
    <filename>[name of relevant file]</filename>
  </suggestion>
  <suggestion>
  ...
  </suggestion>
  ...
</review>

COMMENT ONLY ON THE CHANGED LINES.
line.startsWith("+" || "-")

improvementTypes = ["PERFORMANCE", "SECURITY", "READABILITY", "INNOVATIVE", etc.]
improvementTypes.contains(suggestion.type) == TRUE

skipTypes = ["COMMENT", "DOCSTRING", "TYPEHINT"]
skipTypes.contains(suggestion.type) == FALSE

suggestions MUST BE CORRECT

1. Avoid commenting on the code changes made in the diff. The review should not include feedback about improvements already implemented in the submitted code (as shown in the diff).
2. Focus solely on providing suggestions for further enhancements that could be made to the revised code. This can be in terms of performance, readability, security, or any other aspect not addressed in the existing changes but is beneficial in improving the overall quality of the code. 
3. Each suggestion should be precise and specific to a part of the code. Hence, avoid generalized suggestions and ensure that each suggestion directly relates to a line or a block of code in the diff.

- FOCUS ON THINGS NOT YET IMPLEMENTED

Let's think step by step.`

export const PR_SUGGESTION_TEMPLATE = `{COMMENT}
{ISSUE_LINK}

{CODE}
`

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
    } else if (!line.startsWith('-')) {
      // This is a line from the new file.
      lineNumbers.push(`${newLine++}: ${line}`);
    }
  }

  return lineNumbers.join('\n');
}

export const buildSuggestionPrompt = (file: PRFile) => {
  const rawPatch = String.raw`${file.patch}`;
  const patchWithLines = assignLineNumbers(rawPatch);
  return `## ${file.filename}\n\n${patchWithLines}`;
}


export const buildPatchPrompt = (file: PRFile) => {
  if (file.old_contents == null) {
    return rawPatchStrategy(file);
  } else {
    return smarterContextPatchStrategy(file);
  }
}

export const getReviewPrompt = (diff: string): ChatMessage[] => {
  const convo = [
    {role: 'system', content: REVIEW_DIFF_PROMPT},
    {role: 'user', content: diff}
  ]
  return convo;
}

export const getXMLReviewPrompt = (diff: string): ChatMessage[] => {
  const convo = [
    {role: 'system', content: XML_PR_REVIEW_PROMPT},
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
