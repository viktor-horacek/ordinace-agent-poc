import OpenAI from 'openai';

const baseURL = 'https://openrouter.ai/api/v1';
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.MODEL;

if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
}
if (!model) {
    throw new Error('MODEL is not set');
}


const client = new OpenAI({
    baseURL,
    apiKey,
});

export { client, model };