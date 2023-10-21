import { ChatMessage } from "../constants";
import { getFileContents, editFileContents } from "../reviews";

const TASK_BREAKDOWN_SYSTEM_PROMPT = `Think step-by-step to break down the requested task into non-trivial sub-tasks. The sub-tasks should be a small, self-contained, and independent part of the problem.

The sub-tasks should make sense to a coder, who will then go and attempt to implement the generated sub-tasks.

The coder can do 2 things:
1. create a file
2. edit a file

DO NOT include any testing or validation steps.
DO NOT explicitly say to save changes.
DO NOT mention git.

YOU MUST CALL the taskBreakdown function!
`;

export const getTaskBreakdownPrompt = (task: string): ChatMessage[] => {
    return [
        {"role": "system", "content": TASK_BREAKDOWN_SYSTEM_PROMPT},
        {"role": "user", "content": `Task: ${task}`}
    ]
}

export const TASK_LLM_FUNCTION = [
    {
        "name": "taskBreakdown",
        "description": "Processes a list of tasks",
        "parameters": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "Sub-task to accomplish task"
                }
            },
            "required": ["tasks"]
        }
    },
]

const CODE_AGENT_SYSTEM_PROMPT = `You are an expert NextJS developer.

You are an AI agent who will be provided with a goal to accomplish.
You have access to a NextJS repo.

You will output one action at a time to accomplish the provided goal.
You may also be provided with the file layout in tree format of the project.

When editing code, ensure you output the full line of code including the whitespace. DO NOT include the line numbers! Make sure the code you write is correct!
Keep in mind that the edit function OVERWRITES the code already existing on those lines!
Consider your code change in the context of the whole file! Your code change should not break the existing code!


You are provided with 2 fuctions open and edit, use whichever one will help you accomplish the goal.`;

export const getCodeAgentPrompt = (goal: string, repoTree: string): ChatMessage[] => {
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

export const LLM_FUNCTION_MAP = new Map<string, any>([
    ["open", [getFileContents, ["octokit", "payload", "branch", "filepath"]]],
    ["edit", [editFileContents, ["octokit", "payload", "branch", "filepath", "code", "lineStart", "lineEnd"]]]
]);
