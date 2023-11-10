import { ChatMessage } from "../constants";
export const REPAIR_PROMPT = `You're a seasoned developer faced with a file that's throwing an error. Your task is to diagnose, locate, and fix this error, while considering whether the solution should be implemented in "insert" mode (add new code without affecting the existing ones) or "overwrite" mode (replace erroneous code with the correct one).

1. After reviewing the file content and the parse error, please identify what is causing the error.

2. Please provide the corrected code based on your recommended mode (insert or overwrite).`;

export const USER_REPAIR_MSG = `{FILE}

{ERROR}`;

export const USER_REPAIR_MSG_W_GOAL = `{GOAL}

{FILE}

{ERROR}`;


export const REPAIR_FNs = [
    {
        "name": "repair",
        "description": "Fix for the parser error in the file",
        "parameters": {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "description": "Must be 'insert' or 'overwrite'. Determines the editing mode. If 'insert', the specified content will be added at the beginning of the specified starting line without altering the existing code. If 'overwrite', the existing code from the specified starting line will be replaced with the new content."
                },
                "code": {
                    "type": "string",
                    "description": "The code which will replace the specified lines"
                },
                "lineStart": {
                    "type": "number",
                    "description": "Where the code changes should start"
                }
            },
            "required": ["mode", "code", "lineStart"]
        }
    },
]

export const getRepairPrompt = (fileContents: string, error: string): ChatMessage[] => {
    const msg = USER_REPAIR_MSG.replace("{FILE}", fileContents).replace("{ERROR}", error);

    return [
        {"role": "system", "content": REPAIR_PROMPT},
        {"role": "user", "content": msg}
    ];
}