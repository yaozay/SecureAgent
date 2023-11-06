import OpenAI from 'openai';
import { ChatMessage } from '../constants';
import { AutoblocksTracer } from '@autoblocks/client';

export const chatFns = async (traceTag: string, sessionId: string, convo: ChatMessage[], funcs: any, extraParams = {}) => {
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
    await tracer.sendEvent(`${traceTag}.request`, {
        properties: requestParams,
    });
    try {
        //@ts-ignore
        const response = await openai.chat.completions.create(requestParams);
        await tracer.sendEvent(`${traceTag}.response`, {
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
        await tracer.sendEvent(`${traceTag}.error`, {
            properties: {
                "exc": String(exc)
            },
        });
        throw new Error("Error getting LLM Response");
    }
}