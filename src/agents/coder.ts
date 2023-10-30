import OpenAI from 'openai';
import { BranchDetails, ChatMessage, sleep } from '../constants';
import { LLM_FUNCTIONS, LLM_FUNCTION_MAP, TASK_LLM_FUNCTION, getCodeAgentPrompt, getPlanBreakdownPrompt } from '../prompts/code-prompt';
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import { createBranch } from '../reviews';
import { AutoblocksTracer } from '@autoblocks/client';
import * as crypto from 'crypto';

const chatFunctions = async (sessionId: string, convo: ChatMessage[], funcs: any) => {
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
        function_call: "auto"
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
                exc: exc
            },
        });
        throw new Error("Error getting LLM Response");
    }
}

const postprocessTasks = (tasks: string[]) => {
    return tasks.map((task, idx) => `${idx+1}. ${task}`);
}

const generatePlan = async (sessionId: string, goal: string) => {
    const convo = getPlanBreakdownPrompt(goal);
    const response = await chatFunctions(sessionId, convo, TASK_LLM_FUNCTION);
    const responseMessage = response.choices[0].message;
    console.log(responseMessage);
    if (!responseMessage.function_call) {
        throw "DID NOT CALL A FUNCTION";
    }
    const subtasks: string[] = JSON.parse(responseMessage.function_call.arguments)["tasks"];
    return subtasks;
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

const runStep = async (sessionId: string, convo: ChatMessage[], actions: any[], actionMap: Map<string, string[]>, octokit: Octokit, payload: WebhookEventMap["issues"], branch: BranchDetails) => {
    const response = await chatFunctions(sessionId, convo, LLM_FUNCTIONS);
    const responseMessage = response.choices[0].message;
    console.log("GPT RESPONSE:")
    console.log(responseMessage);
    // Step 2: check if GPT wanted to call a function

    if (responseMessage.function_call) {
        let functionName = responseMessage.function_call.name;
        const functionArgs = JSON.parse(responseMessage.function_call.arguments);

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
        const [f, args] = funtionInfo;
        console.log(args);
        
        let nextStep: string = functionArgs["nextStep"] || null;
        const passingArgs: any[] = [];
        args.forEach((arg: string) => {
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
        const functionResponse = await f(...passingArgs);
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
                step = await runStep(sessionId, convo, actions, actionMap, octokit, payload, branch);
            } catch (exc) {
                console.log(exc);
                console.log(`Executing single retry!`);
                step = await runStep(sessionId, convo, actions, actionMap, octokit, payload, branch);
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
    console.log("DONE PROCESSING");
    
    return "done";
}