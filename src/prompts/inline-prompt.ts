import { ChatMessage, PRSuggestion } from "../constants"

export const INLINE_FIX_PROMPT = `In the following task, you are required to convert the given code suggestion into a valid code fix for the corresponding file content which is also provided. The original suggestion XML will be presented similar to this:

\`\`\`xml
<suggestion>
  <describe>Your Description Here</describe>
  <type>Your Type Here</type>
  <comment>Your Comment Here</comment>
  <code>Your Code Here</code>
  <filename>Your File Name Here</filename>
</suggestion>
\`\`\`

The "comment" field contains the specific request for code changes. Your task is to implement the change according to the suggestion's comment and then provide the code fix, considering the line number where the change was applied.

Remember, your code fix must be correct according to the suggestion, and the updated code must be functional, error-free and valid. It must be in the same language as the provided file.

Now, using the above instructions, please perform the required changes to the provided suggestion and file content.`

export const INLINE_FN = [
    {
        "name": "fix",
        "description": "The code fix to address the suggestion and rectify the issue",
        "parameters": {
            "type": "object",
            "properties": {
                "comment": {
                    "type": "string",
                    "description": "Why this change improves the code"
                },
                "code": {
                    "type": "string",
                    "description": "The code fix to address the suggestion, which replace the specified lines"
                },
                "lineStart": {
                    "type": "number",
                    "description": "Which line number the code changes should start on"
                }
            }
        },
        "required": ["action"]
    }
]

const INLINE_USER_MESSAGE_TEMPLATE = `{SUGGESTION}

{FILE}`

const assignFullLineNumers = (contents: string): string => {
    const lines = contents.split('\n');
    let lineNumber = 1;
    const linesWithNumbers = lines.map(line => {
        const numberedLine = `${lineNumber}: ${line}`;
        lineNumber++;
        return numberedLine;
    });
    return linesWithNumbers.join('\n');
}

const convertPRSuggestionToString = (suggestion: PRSuggestion): string => {
    return `<suggestion>
    <describe>${suggestion.describe}</describe>
    <type>${suggestion.type}</type>
    <comment>${suggestion.comment}</comment>
    <code>${suggestion.code}</code>
    <filename>${suggestion.filename}</filename>
</suggestion>`;
}

export const getInlineFixPrompt = (fileContents: string, suggestion: PRSuggestion): ChatMessage[] => {
    const userMessage = INLINE_USER_MESSAGE_TEMPLATE.replace("{SUGGESTION}", convertPRSuggestionToString(suggestion)).replace("{FILE}", assignFullLineNumers(fileContents));
    return [
        { role: "system", content: INLINE_FIX_PROMPT },
        { role: "user", content: userMessage}
    ];
}
