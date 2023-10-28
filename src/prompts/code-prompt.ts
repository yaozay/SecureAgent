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

export const getPlanBreakdownPrompt = (task: string): ChatMessage[] => {
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

const CODE_AGENT_SYSTEM_PROMPT = `You are an expert developer.

You are an AI agent who will be provided with a goal to accomplish.
You have access to a code repo.

You will output one action at a time to accomplish the provided goal.
You may also be provided with the file layout in tree format of the project.

When editing code, ensure you output the full line of code including the whitespace. DO NOT include line numbers! Make sure the code you write is correct!
Consider your code change in the context of the whole file! Your code change should not break the existing code!


You are provided with 3 fuctions done, open, and edit, use whichever one will help you accomplish the goal.
ONLY RESPOND WITH FUNCTION CALLS OPEN, EDIT, or DONE.
YOU MUST CALL DONE ONCE THE GOAL IS COMPLETE.`;

export const getCodeAgentPrompt = (goal: string, repoTree: string, tasks: string[]): ChatMessage[] => {
    return [
        {"role": "system", "content": CODE_AGENT_SYSTEM_PROMPT},
        {"role": "user", "content": `Goal:\n${goal}\n\nPlan:\n${tasks.join("\n")}\n\nTree: ${repoTree}`}
    ]
}

export const LLM_FUNCTIONS = [
    {
        "name": "done",
        "description": "Marks the provided goal as done",
        "parameters": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "The completed goal."
                }
            },
            "required": ["goal"]
        }
    },
    {
        "name": "open",
        "description": "Get the contents of the given filepath",
        "parameters": {
            "type": "object",
            "properties": {
                "filepath": {
                    "type": "string",
                    "description": "The filepath to get the contents of."
                },
                "nextStep": {
                    "type": "string",
                    "description": "The next part of the plan to achieve the goal."
                }
            },
            "required": ["filepath", "nextStep"]
        }
    },
    {
        "name": "edit",
        "description": "Inserts or overwrites at the specified lines of the given file with the provided code",
        "parameters": {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "description": "Must be 'insert' or 'overwrite'. Determines the editing mode. If 'insert', the specified content will be added at the beginning of the specified starting line without altering the existing code. If 'overwrite', the existing code from the specified starting line will be replaced with the new content."
                },
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
                "nextStep": {
                    "type": "string",
                    "description": "The next part of the plan to achieve the goal."
                }
            },
            "required": ["filepath", "code", "lineStart", "lineEnd", "nextStep"]
        }
    },
]

const markDone = (goal: string) => {
    console.log(`Marking complete: ${goal}`);
    return { result: `Marking complete: ${goal}`, functionString: `done("${goal}")`};
}

export const LLM_FUNCTION_MAP = new Map<string, any>([
    ["open", [getFileContents, ["octokit", "payload", "branch", "filepath"]]],
    ["edit", [editFileContents, ["octokit", "payload", "branch", "mode", "filepath", "code", "lineStart"]]],
    ["done", [markDone, ["goal"]]]
]);
