import { getFileContents, editFileContents } from "../reviews";

const GOAL_SYSTEM_PROMPT = `You are an AI agent.
You will be passed a goal by the user.
Break the given goal down into specific steps.

ex.
Make the button on the landing page yellow and add a text entry area below the button

result:
1. Make the button on the landing page yellow.
2. Add a text entry area below the button on the landing page

`

const CODE_AGENT_SYSTEM_PROMPT = `You are an expert NextJS developer.

You are an AI agent who will be provided with a goal to accomplish.
You have access to a NextJS repo.

You will output one action at a time to accomplish the provided goal.
You may also be provided with the file layout in tree format of the project.

When editing code, ensure you output the full line of code including the whitespace. Make sure the code you write is correct!
Keep in mind that the edit function OVERWRITES the code already existing on those lines!


You are provided with 2 fuctions open and edit, use whichever one will help you accomplish the goal.`;

export const getCodeAgentPrompt = (goal: string, repoTree: string) => {
    return [
        {"role": "system", "content": CODE_AGENT_SYSTEM_PROMPT},
        {"role": "user", "content": `Goal: ${goal}\nTree: ${repoTree}`}
    ]
}

export const LLM_FUNCTIONS = [
    {
        "name": "open",
        "description": "Get the contents of the given filepath",
        "parameters": {
            "type": "object",
            "properties": {
                "filepath": {
                    "type": "string",
                    "description": "The filepath to get the contents of."
                }
            },
            "required": ["filepath"]
        }
    },
    {
        "name": "edit",
        "description": "Overwrites the specified lines of the given file with the provided code",
        "parameters": {
            "type": "object",
            "properties": {
                "filepath": {
                    "type": "string",
                    "description": "The filepath to edit the contents of"
                },
                "code": {
                    "type": "string",
                    "description": "The code which will replace the specified lines"
                },
                "lineStart": {
                    "type": "number",
                    "description": "Where the code changes should start"
                },
                "lineEnd": {
                    "type": "number",
                    "description": "Where the code changes should end"
                },
            },
            "required": ["filepath", "code", "lineStart", "lineEnd"]
        }
    },
]

// const editFileContents = (filepath: string, code: string, lineStart: number, lineEnd: number) => {
//     console.log(code);
//     return `Edited file: ${filepath}\n${code}`;
// }

export const LLM_FUNCTION_MAP = new Map<string, any>([
    ["open", [getFileContents, ["octokit", "payload", "branch", "filepath"]]],
    ["edit", [editFileContents, ["octokit", "payload", "branch", "filepath", "code", "lineStart", "lineEnd"]]]
]);
