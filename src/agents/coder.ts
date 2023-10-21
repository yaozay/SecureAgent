import OpenAI from 'openai';
import { BranchDetails, ChatMessage, sleep } from '../constants';
import { LLM_FUNCTIONS, LLM_FUNCTION_MAP, TASK_LLM_FUNCTION, getCodeAgentPrompt, getTaskBreakdownPrompt } from '../prompts/code-prompt';
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import { createBranch } from '../reviews';

const chatFunctions = async (convo: ChatMessage[], funcs: any) => {
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await openai.chat.completions.create({
        model: "gpt-4-0613",
        //@ts-ignore
        messages: convo,
        functions: funcs,
        function_call: "auto"
    });
    return response;
}

const postprocessTasks = (tasks: string[]) => {
    return tasks.map((task, idx) => `${idx+1}. ${task}`);
}

const generateTaskList = async (goal: string) => {
    const convo = getTaskBreakdownPrompt(goal);
    const response = await chatFunctions(convo, TASK_LLM_FUNCTION);
    const responseMessage = response.choices[0].message;
    console.log(responseMessage);
    if (!responseMessage.function_call) {
        throw "DID NOT CALL A FUNCTION";
    }
    const subtasks: string[] = JSON.parse(responseMessage.function_call.arguments)["tasks"];
    return subtasks;
}

const runStep = async (convo: ChatMessage[], actions: any[], octokit: Octokit, payload: WebhookEventMap["issues"], branch: BranchDetails) => {
    const response = await chatFunctions(convo, LLM_FUNCTIONS);
    const responseMessage = response.choices[0].message;
    console.log("GPT RESPONSE:")
    console.log(responseMessage);
    // Step 2: check if GPT wanted to call a function

    if (responseMessage.function_call) {
        const functionName = responseMessage.function_call.name;
        const funtionInfo = LLM_FUNCTION_MAP.get(functionName);
        const [f, args] = funtionInfo;
        console.log(args);
        const functionArgs = JSON.parse(responseMessage.function_call.arguments);
        
        const passingArgs: any[] = [];
        let relevantTask: number = null;
        args.forEach((arg: string) => {
            if (arg == "octokit") {
                passingArgs.push(octokit);
            } else if (arg == "payload") {
                passingArgs.push(payload);
            } else if (arg == "branch") {
                passingArgs.push(branch);
            } else if (arg == "taskNumber") { 
                relevantTask = functionArgs["taskNumber"];
            } else {
                passingArgs.push(functionArgs[arg]);
            }
        });
        // if (actions.length > 0) {
        //     const pendingAction = [functionName, functionArgs];
        //     const lastAction = actions[actions.length - 1];
        //     if (JSON.stringify(pendingAction) === JSON.stringify(lastAction)) {
        //         throw new Error("Repeating action!");
        //     }
        // }
        actions.push([functionName, functionArgs]);
        console.log("CALLING");
        console.log(passingArgs.length);
        const functionResponse = await f(...passingArgs);
        console.log("CALLED");
        return {
            "stepResult": functionResponse,
            "relevantTask": relevantTask,
            "functionName": functionName
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
    const branch = await createBranch(octokit, payload);

    // let tasks = await generateTaskList(goal);

    // const convo = getCodeAgentPrompt(goal, postprocessTasks(tasks).join("\n"), tree);
    const convo = getCodeAgentPrompt(goal, tree);
    const actions: any[] = [];
    console.log(convo);
    const stepLimit = 5;
    let stepCount = 0;
    while (stepCount < stepLimit) {
        console.log(`ON: ${stepCount + 1}/${stepLimit}`);
        try {
            const step = await runStep(convo, actions, octokit, payload, branch);
            console.log(step);
            const { stepResult, relevantTask, functionName } = step;
            // console.log(stepResult);
            convo.push({"role": "user", "content": stepResult});
            // if (functionName == "edit") {
            //     console.log("EDIT updating task list.");
            //     let remTasks = [tasks[tasks.length-1]];
            //     if (relevantTask < tasks.length) { 
            //         remTasks = tasks.slice(relevantTask);
            //     }
                
            //     // overwriting tasks
            //     tasks = remTasks;

            //     convo.push({"role": "user", "content": `Tasks:\n${postprocessTasks(tasks).join("\n")}`})

            //     console.log(`REMAINING TASKS: ${postprocessTasks(tasks).join("\n")}`);
            // }
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