import { ChatMessage } from "../constants";

export const TASK_LIST_VOTE_PROMPT = `Determine which plan is best to achieve the goal.`;

export const getTaskListVotePrompt = (goal: string, taskLists: string[]): string => {
    return `Determine which plan is best to achieve the goal.
Goal: ${goal}

`;
}

export const LLM_VOTE_FN = [
    {
        "name": "evaluateTaskList",
        "description": "Returns the index of the best plan in the zero-based list that is most likely to accomplish the given goal",
        "parameters": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "number",
                    "description": "The index of the best plan"
                },
                "reason": {
                    "type": "string",
                    "description": "Reason why this plan was chosen over the rest"
                }
            },
            "required": ["index", "reason"]
        }
    },
]

export const getTaskVotePrompt = (goal: string, taskLists: string[][]): ChatMessage[] => {
    const taskListStrs = taskLists.map((taskList, idx) => {
        return `Plan ${idx}: ${taskList.join(", ")}`
    })
    return [
        {"role": "system", "content": `${TASK_LIST_VOTE_PROMPT}\nGoal: ${goal}\n${taskListStrs.join("\n")}`}
    ]
}