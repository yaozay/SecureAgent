import { ChatMessage } from "../constants";
import { getFileContents, editFileContents } from "../reviews";

const TASK_BREAKDOWN_SYSTEM_PROMPT = `Begin by thoughtfully dissecting the given task into smaller, manageable sub-tasks. Ensure that each sub-task is compact, self-sufficient, and independent. These sub-tasks should be comprehendible for a coder and conducive for implementation. 

The coder’s role involves two activities: 
1. Constructing a new file.
2. Modifying an existing file.

Articulate a comprehensive plan that facilitates the accomplishment of the final goal from start to finish. Be sure to integrate the code you generate into this plan.

No code should be output in this exercise. Instead, propose the creation of a class with specified methods. Provide an overarching description of the desired code modifications.

Avoid reference to testing or verification steps in this prompt. There’s no need to suggest saving changes or make any mention of GIT. 

The aim of this activity is to develop a substantive task distribution that a junior engineer can easily act upon, without dictating steps to the minutest details. Suggestions such as "formulate a class with these methods" are more helpful than delineating the code or indicating every method. The sequence should be comprehensive to avoid omissions, such as incorporating the developed code, amongst other activities.`;

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

- You are an AI agent who will be provided with a goal to accomplish.
- You have access to a code repo.
- You will output one action at a time to accomplish the provided goal.
- You may also be provided with the file layout in tree format of the project.
- When editing code, ensure you output the full line of code including the whitespace.
- DO NOT include line numbers! Make sure the code you write is correct!
- Consider your code change in the context of the whole file! Your code change should not break the existing code!
- You are provided with 3 actions done, open, and edit, use whichever one will help you accomplish the goal.
- ONLY RESPOND WITH THE ACTIONS: OPEN, EDIT, or DONE.
- YOU MUST CALL DONE ONCE THE GOAL IS COMPLETE.`;

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

export const COMBINED_FNS = [
    {
        "name": "act",
        "description": "The action to take which gets you closer to achieving your goal",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "ALWAYS REQUIRED! The action to take, must be open, edit, or done!"
                },
                "filepath": {
                    "type": "string",
                    "description": "action == edit || action == open. The filepath to apply the action to"
                },
                "mode": {
                    "type": "string",
                    "description": "action == edit. Must be 'insert' or 'overwrite'. Determines the editing mode. If 'insert', the specified content will be added at the beginning of the specified starting line without altering the existing code. If 'overwrite', the existing code from the specified starting line will be replaced with the new content. Can create a new file too."
                },
                "code": {
                    "type": "string",
                    "description": "action == edit. The code which will replace the specified lines"
                },
                "lineStart": {
                    "type": "number",
                    "description": "action == edit. Where the code changes should start"
                },
                "nextStep": {
                    "type": "string",
                    "description": "action == edit || action == open. The next part of the plan to achieve the goal."
                },
                "goal": {
                    "type": "string",
                    "description": "action == done. The completed goal."
                }
            }
        },
        "required": ["action"]
    }
]

const markDone = (goal: string) => {
    console.log(`Marking complete: ${goal}`);
    return { result: `Marking complete: ${goal}`, functionString: `done("${goal}")`};
}

export const openFnStr = (filepath: string) => {
    return `calling open with args: ${filepath}`;
}

export const editFnStr = (mode: string, filepath: string, code: string, lineStart: number) => {
    return `calling edit with args: ${[mode, filepath, code].join(", ")}`;
}

export const doneFnStr = (goal: string) => {
    return `calling doen with args: ${goal}`;
}


// fn, args, fnStr
export type FunctionMapType = {
    fn: Function,
    fnArgs: string[],
    fnStr: (...arg: any) => string,
    fnStrArgs: string[]
};

export const LLM_FUNCTION_MAP = new Map<string, FunctionMapType>([
    [
        "open", 
        {
            fn: getFileContents,
            fnArgs: ["octokit", "payload", "branch", "filepath"], 
            fnStr: openFnStr,
            fnStrArgs: ["filepath"]
        }
    ],
    [
        "edit",
        {
            fn: editFileContents,
            fnArgs: ["octokit", "payload", "branch", "mode", "filepath", "code", "lineStart"],
            fnStr: editFnStr,
            fnStrArgs: ["mode", "filepath", "code", "lineStart"]
        }
    ],
    [
        "done", 
        {
            fn: markDone,
            fnArgs: ["goal"],
            fnStr: doneFnStr,
            fnStrArgs: ["goal"]
        }
    ]
]);
