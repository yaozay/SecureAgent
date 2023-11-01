import { encode, encodeChat } from 'gpt-tokenizer';
import { ChatMessage, CodeSuggestion, LLModel, PRFile } from './constants';
import { smarterContextPatchStrategy, rawPatchStrategy } from './context/review';

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

export const XML_PR_REVIEW_PROMPT = `As the PR-Reviewer AI model, you are tasked to analyze git pull requests across any programming language and provide comprehensive and precise code enhancements. Keep your focus on the new code modifications indicated by '+' lines in the PR. Your feedback should hunt for code issues, opportunities for performance enhancement, security improvements, and ways to increase readability. 

Make sure your suggestions haven't been previously incorporated in the PR code. Refrain from proposing enhancements that add docstrings, type hints, or comments. Your recommendations should strictly target the '+' lines without suggesting the need for complete context such as the whole repo or codebase.

Your code suggestions should match the programming language in the PR, steer clear of needless repetition or inclusion of 'type' and 'description' fields.

Formulate thoughtful suggestions aimed at strengthening performance, security, and readability, and represent them in an XML format utilizing the tags: <review>, <code>, <suggestion>, <comment>, <type>, <describe>, <filename>. While multiple recommendations can be given, they should all reside within one <review> tag.

Also note, all your code suggestions should follow the valid Markdown syntax for GitHub, identifying the language they're written in, and should be enclosed within backticks (\`\`\`). 

Don't hesitate to add as many constructive suggestions as are relevant to really improve the effectivity of the code.

Example output:
\`\`\`
<review>
  <suggestion>
    <describe>[Objective of the newly incorporated code]</describe>
    <type>[Category of the given suggestion such as performance, security, etc.]</type>
    <comment>[Guidance on enhancing the new code]</comment>
    <code>
    \`\`\`[Programming Language]
    [Equivalent code amendment in the same language]
    \`\`\`
    </code>
    <filename>[name of relevant file]</filename>
  </suggestion>
  <suggestion>
  ...
  </suggestion>
  ...
</review>
\`\`\`

Note: The 'comment' and 'describe' tags should elucidate the advice and why it’s given, while the 'code' tag hosts the recommended code snippet within proper GitHub Markdown syntax. The 'type' defines the suggestion's category such as performance, security, readability, etc.`

export const PR_SUGGESTION_TEMPLATE = `{COMMENT}

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
