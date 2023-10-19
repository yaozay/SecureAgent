import OpenAI from 'openai';
import { BranchDetails, ChatMessage } from '../constants';
import { LLM_FUNCTIONS, LLM_FUNCTION_MAP, getCodeAgentPrompt } from '../prompts/code-prompt';
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import { createBranch } from '../reviews';

const runStep = async (convo: ChatMessage[], actions: any[], octokit: Octokit, payload: WebhookEventMap["issues"], branch: BranchDetails) => {
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await openai.chat.completions.create({
        model: "gpt-4-0613",
        //@ts-ignore
        messages: convo,
        functions: LLM_FUNCTIONS,
        function_call: "auto"
    });
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
        const passingArgs = args.map((arg: string) => {
            if (arg == "octokit") {
                return octokit;
            } else if (arg == "payload") {
                return payload;
            } else if (arg == "branch") {
                return branch;
            }
            return functionArgs[arg];
        });
        if (actions.length > 0) {
            const pendingAction = [functionName, functionArgs];
            const lastAction = actions[actions.length - 1];
            if (JSON.stringify(pendingAction) === JSON.stringify(lastAction)) {
                throw new Error("Repeating action!");
            }
        }
        actions.push([functionName, functionArgs]);
        console.log("CALLING");
        console.log(passingArgs.length);
        const functionResponse = await f(...passingArgs);
        console.log("CALLED");
        return functionResponse;
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
    const convo = getCodeAgentPrompt(goal, tree);
    const actions: any[] = [];
    // console.log(convo);
    const stepLimit = 10;
    let stepCount = 0;
    while (stepCount < stepLimit) {
        console.log(`ON: ${stepCount}/${stepLimit}`);
        try {
            const stepResult = await runStep(convo, actions, octokit, payload, branch);
            // console.log(stepResult);
            convo.push({"role": "user", "content": stepResult});
        } catch (exc) {
            console.log(exc);
            console.log("EXITING");
            break;
        }
        console.log(`DONE: ${stepCount}/${stepLimit}`);
        stepCount += 1;
    }
    console.log(convo);
    console.log("DONE PROCESSING");
    
    return "done";
}