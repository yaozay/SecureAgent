import OpenAI from 'openai';
import { BranchDetails, ChatMessage, sleep } from '../constants';
import { COMBINED_FNS, LLM_FUNCTIONS, LLM_FUNCTION_MAP, TASK_LLM_FUNCTION, getCodeAgentPrompt, getPlanBreakdownPrompt } from '../prompts/code-prompt';
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import { commentIssue, createBranch } from '../reviews';
import { AutoblocksTracer } from '@autoblocks/client';
import * as crypto from 'crypto';
import { LLM_ACTION_VOTE_FN, LLM_VOTE_FN, getActionVotePrompt, getTaskVotePrompt } from '../prompts/tree-of-thought';

const chatFunctions = async (sessionId: string, convo: ChatMessage[], funcs: any, extraParams = {}) => {
    const tracer = new AutoblocksTracer(process.env.AUTOBLOCKS_INGESTION_KEY, {
        traceId: sessionId,
        properties: {
            provider: 'openai',
        },
    });
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });
    const requestParams = {
        model: "gpt-4-0613",
        messages: convo,
        functions: funcs,
        temperature: 0,
        ...extraParams
    };
    await tracer.sendEvent('code-agent.request', {
        properties: requestParams,
    });
    try {
        //@ts-ignore
        const response = await openai.chat.completions.create(requestParams);
        await tracer.sendEvent('code-agent.response', {
            properties: {
                response
            },
        });
        if (!response.choices[0].message.function_call) {
            throw new Error(`Failed to call function. Context:\n${response.choices[0].message.content}`);
        }
        return response;
    } catch (exc) {
        console.log(exc);
        await tracer.sendEvent('code-agent.error', {
            properties: {
                "exc": String(exc)
            },
        });
        throw new Error("Error getting LLM Response");
    }
}

const postprocessTasks = (tasks: string[]) => {
    return tasks.map((task, idx) => `${idx+1}. ${task}`);
}

const voteOnDecision = async (sessionId: string, convo: ChatMessage[], voteFn: any, voteFnName: string, n: number = 1): Promise<number> => {
    const voteResp = await chatFunctions(sessionId, convo, voteFn, {"function_call": {"name": voteFnName}, "temperature": 0, n: n});
    const voteIdxMap = new Map<number, number>();
    voteResp.choices.forEach((choice) => {
        const selectedIdx: number = JSON.parse(choice.message.function_call.arguments)["index"];
        voteIdxMap.set(selectedIdx, voteIdxMap.get(selectedIdx) + 1 || 1);
    });
    let maxVotes = 0;
    let maxKey;
    voteIdxMap.forEach((value, key) => {
        if (value > maxVotes) {
            maxVotes = value;
            maxKey = key;
        }
    });
    console.log(voteIdxMap);
    return maxKey;
}

const generatePlan = async (sessionId: string, goal: string) => {
    const convo = getPlanBreakdownPrompt(goal);
    const response = await chatFunctions(sessionId, convo, TASK_LLM_FUNCTION, {"function_call": {"name": "taskBreakdown"}, "temperature": 0.7, n : 3});

    const taskLists: string[][] = response.choices.map((choice) => {
        return JSON.parse(choice.message.function_call.arguments)["tasks"];
    });
 
    const taskVotePrompt = getTaskVotePrompt(goal, taskLists);
    const selectedTaskResponse = await chatFunctions(sessionId, taskVotePrompt, LLM_VOTE_FN, {"function_call": {"name": "evaluateTaskList"}, "temperature": 0.7})

    const selectedIdx: number = JSON.parse(selectedTaskResponse.choices[0].message.function_call.arguments)["index"];

    return taskLists[selectedIdx];
}

const canTakeAction = (actionMap: Map<string, string[]>, proposedAction: string, filepath: string) => {
    if (proposedAction == "edit") {
        const filesOpened = actionMap.get("open") || [];
        if (filesOpened.includes(filepath)) { // must have opened file before editing (stops blind edits)
            return true;
        }
        return false;
    }
    return true;
}

const buildActionSummary = (actions: any[], convo: ChatMessage[]): string => {
    if (actions.length == 0) {
        return "No actions taken."
    }

    const actStrs = actions.map(act => {
        const [fName, args] = act;
        const { fnStrArgs } =LLM_FUNCTION_MAP.get(fName);
        const passingArgs = fnStrArgs.map((arg) => args[arg]);
        return `calling ${fName} with args: ${passingArgs.join(", ")}`
    });
    return actStrs.join("\n");
}

const chatActionToT = async (sessionId: string, goal: string, plan: string[], actions: string[], convo: ChatMessage[]) => {
    console.log("CODE ToT");
    const chats = await chatFunctions(sessionId, convo, COMBINED_FNS, {function_call: {"name": "act"}, temperature: 0.7, n: 3});
    const fnStrs: string[] = chats.choices.map(choice => {
        // get the right args based on the function_call and call fnStr
        const functionArgs = JSON.parse(choice.message.function_call.arguments);
        const {fnStr, fnStrArgs} = LLM_FUNCTION_MAP.get(functionArgs["action"]);
        const passingArgs = fnStrArgs.map((fa) => functionArgs[fa]);
        return fnStr(...passingArgs);
    });
    if (fnStrs.every((val, i, arr) => val === arr[0])) {
        console.log("Skipping vote, all equal.")
        return chats.choices[0];
    }
    const summary = buildActionSummary(actions, convo);
    const voteConvo = getActionVotePrompt(goal, plan.join("\n"), summary, fnStrs);
    console.log(voteConvo);
    const selectedIdx = await voteOnDecision(sessionId, voteConvo, LLM_ACTION_VOTE_FN, "evaluateAction", 3);
    console.log(selectedIdx);
    return chats.choices[selectedIdx];
}

const chatFn = async (sessionId: string, convo: ChatMessage[], funcs: any, extraParams = {}) => {
    const resp = await chatFunctions(sessionId, convo, funcs, extraParams);
    return resp.choices[0];
}

const runStep = async (sessionId: string, goal: string, tasks: string[], convo: ChatMessage[], actions: any[], actionMap: Map<string, string[]>, octokit: Octokit, payload: WebhookEventMap["issues"], branch: BranchDetails) => {
    const response = await chatActionToT(sessionId, goal, tasks, actions, convo);//chatFn(sessionId, convo, LLM_FUNCTIONS);
    const responseMessage = response.message;
    console.log("GPT RESPONSE:")
    console.log(responseMessage);
    // Step 2: check if GPT wanted to call a function

    if (responseMessage.function_call) {
        const functionArgs = JSON.parse(responseMessage.function_call.arguments);
        let functionName = functionArgs["action"].toLowerCase();
        if (functionName == "edit" || functionName == "open") {
            if (!canTakeAction(actionMap, functionName, functionArgs["filepath"])) {
                console.log("FORCING OPEN FIRST");
                functionName = "open";
            }
            let files = actionMap.get(functionName) || [];
            files.push(functionArgs["filepath"]);
            actionMap.set(functionName, files);
        }

        const funtionInfo = LLM_FUNCTION_MAP.get(functionName);
        const {fn, fnArgs} = funtionInfo;
        console.log(fnArgs);
        
        let nextStep: string = functionArgs["nextStep"] || null;
        const passingArgs: any[] = [];
        fnArgs.forEach((arg: string) => {
            if (arg == "octokit") {
                passingArgs.push(octokit);
            } else if (arg == "payload") {
                passingArgs.push(payload);
            } else if (arg == "branch") {
                passingArgs.push(branch);
            } else {
                passingArgs.push(functionArgs[arg]);
            }
        });
        actions.push([functionName, functionArgs]);
        console.log("CALLING");
        console.log(passingArgs.length);
        const functionResponse = await fn(...passingArgs);
        console.log("CALLED");
        return {
            "stepResult": functionResponse,
            "functionName": functionName,
            "nextStep": nextStep
        }
    }
    //     return functionResponse;
        // messages.push(responseMessage);  // extend conversation with assistant's reply
        // messages.push({
        //     "role": "function",
        //     "name": functionName,
        //     "content": functionResponse,
        // });  // extend conversation with function response
        // const secondResponse = await openai.chat.completions.create({
        //     model: "gpt-3.5-turbo",
        //     messages: messages,
        // });  // get a new response from GPT where it can see the function response
        // return secondResponse;
    // }
    console.log("!!!");
    throw "No function called";
}

export const processTask = async (goal: string, tree: string, octokit: Octokit, payload: WebhookEventMap["issues"]) => {
    const sessionId = crypto.randomUUID();
    const branch = await createBranch(octokit, payload);

    let tasks = await generatePlan(sessionId, goal);

    const convo = getCodeAgentPrompt(goal, tree, tasks);
    const actions: any[] = [];
    const actionMap = new Map<string, string[]>([]);
    console.log(convo);
    const stepLimit = 10;
    let stepCount = 0;
    while (stepCount < stepLimit) {
        console.log(`ON: ${stepCount + 1}/${stepLimit}`);
        try {
            let step = null;
            try {
                step = await runStep(sessionId, goal, tasks, convo, actions, actionMap, octokit, payload, branch);
            } catch (exc) {
                console.log(exc);
                console.log(`Executing single retry!`);
                step = await runStep(sessionId, goal, tasks, convo, actions, actionMap, octokit, payload, branch);
            }
            console.log(step);
            const { stepResult, functionName, nextStep } = step;
            const { result, functionString } = stepResult;
            // console.log(stepResult);
            convo.push({"role": "assistant", "content": functionString});
            convo.push({"role": "user", "content": `${result}\n\nNext Step: ${nextStep}`});
            if (functionName == "done") {
                console.log("GOAL COMPLETED");
                break;
            }
        } catch (exc) {
            console.log(exc);
            console.log("EXITING");
            break;
        }
        console.log(`DONE: ${stepCount + 1}/${stepLimit}`);
        await sleep(5000);
        stepCount += 1;
    }
    console.log(convo);
    await commentIssue(octokit, payload, "Finished Processing")
    console.log("DONE PROCESSING");
    
    return "done";
}