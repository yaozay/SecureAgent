import OpenAI from 'openai';
import { ChatMessage } from '../constants';

export const chatFns = async (traceTag: string, sessionId: string, convo: ChatMessage[], funcs: any, extraParams = {}) => {
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
    try {
        //@ts-ignore
        const response = await openai.chat.completions.create(requestParams);
        if (!response.choices[0].message.function_call) {
            throw new Error(`Failed to call function. Context:\n${response.choices[0].message.content}`);
        }
        return response;
    } catch (exc) {
        throw new Error("Error getting LLM Response");
    }
}