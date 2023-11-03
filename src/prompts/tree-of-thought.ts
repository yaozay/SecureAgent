import { ChatMessage } from "../constants";

export const TASK_LIST_VOTE_PROMPT = `Determine which plan is best to achieve the goal.`;

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

export const CODE_ACTION_VOTE_PROMPT = `Determine which action is best to take to achieve or get closer to achieving the desired goal.
Goal:
{GOAL}
Here is the proposed plan to achieve that goal:
{PLAN}

Here is a summary of your actions so far:
{SUMMARY}

Here are the options:
{OPTIONS}

Respond with your reasoning for taking the selected action, the zero based index of the selected action that has the highest likelihood to get you closer to achieving the goal.`;

export const LLM_ACTION_VOTE_FN = [
    {
        "name": "evaluateAction",
        "description": "Returns the index of the best option in the zero-based list that is most likely to get you closer towards accomplishing the goal",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Reason why this plan was chosen over the rest"
                },
                "index": {
                    "type": "number",
                    "description": "The index of the best plan"
                }
            },
            "required": ["index", "reason"]
        }
    },
]

export const getActionVotePrompt = (goal: string, plan: string, summary: string, options: string[]): ChatMessage[] => {
    const labeledOpts = options.map((opt, idx) => `${idx}: ${opt}`);
    const injected = CODE_ACTION_VOTE_PROMPT.replace("{GOAL}", goal).replace("{PLAN}", plan).replace("{SUMMARY}", summary).replace("{OPTIONS}", labeledOpts.join("\n"));
    return [
        { role: "system", content: injected }
    ]
}