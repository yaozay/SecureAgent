import OpenAI from 'openai';
import { getReviewPrompt } from './prompts';


export const reviewDiff = async (diff: string) => {
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });
    console.log(diff);
    const convo = getReviewPrompt(diff);
    const chatCompletion = await openai.chat.completions.create({
        //@ts-ignore
        messages: convo,
        model: 'gpt-3.5-turbo',
    });
    console.log("done")
    return chatCompletion.choices[0].message.content;

}