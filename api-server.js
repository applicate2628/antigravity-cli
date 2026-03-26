import express from 'express';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { ANTIGRAVITY_SYSTEM_INSTRUCTION, getAntigravityHeaders } from 'opencode-antigravity-auth/dist/src/constants.js';
import { getValidTokens } from './auth.js';

export async function startApiServer(port) {
    const app = express();
    app.use(express.json());

    // Load tokens (re-reads on each request for hot-reload support)
    const getKeys = async () => {
        return await getValidTokens();
    };

    let currentKeyIndex = 0;

    app.post('/v1/chat/completions', async (req, res) => {
        try {
            const keys = await getKeys();
            if (keys.length === 0) {
                return res.status(401).json({ error: "No auth tokens found. Run 'node index.js login' first." });
            }

            const { messages = [], stream = false, temperature = 0.7 } = req.body;
            // Hard-coded to Claude Opus 4.6 Thinking (ignores client model selection)
            const model = 'claude-opus-4-6-thinking';
            
            // Extract the last user message
            const lastUserMsg = messages.filter(m => m.role === 'user').pop();
            const prompt = lastUserMsg ? lastUserMsg.content : '';

            if (!prompt) {
                return res.status(400).json({ error: "No valid prompt found in messages array." });
            }

            let success = false;
            let retryCount = 0;
            const maxRetries = keys.length;

            while (!success && retryCount < maxRetries) {
                try {
                    const isApiKey = keys[currentKeyIndex] && keys[currentKeyIndex].startsWith('AIza');
                    const apiModel = model.replace(/^antigravity-/i, '');
                    const CLOUD_CODE_BASE = 'https://cloudcode-pa.googleapis.com';
                    const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
                    
                    let url, headers, requestBody;

                    if (isApiKey) {
                        url = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}?key=${keys[currentKeyIndex]}`;
                        headers = { 'Content-Type': 'application/json' };
                        requestBody = {
                            contents: [{ role: 'user', parts: [{ text: prompt }] }],
                            generationConfig: { temperature, maxOutputTokens: 8192 }
                        };
                    } else {
                        const agentHeaders = getAntigravityHeaders();
                        url = `${CLOUD_CODE_BASE}/v1internal:streamGenerateContent?alt=sse`;
                        headers = {
                            'Authorization': `Bearer ${keys[currentKeyIndex]}`,
                            'Content-Type': 'application/json',
                            ...agentHeaders
                        };
                        
                        requestBody = {
                            project: DEFAULT_PROJECT_ID,
                            model: apiModel,
                            request: {
                                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                                systemInstruction: { parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }] },
                                generationConfig: { temperature, maxOutputTokens: 8192 }
                            }
                        };

                        if (apiModel.includes('thinking') || apiModel.includes('gemini-3')) {
                            if (apiModel.includes('claude') || apiModel.includes('sonnet')) {
                                requestBody.request.generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: 1024 };
                            } else {
                                let level = 'medium';
                                if (apiModel.includes('low')) level = 'low';
                                if (apiModel.includes('high')) level = 'high';
                                requestBody.request.generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
                            }
                        }
                    }

                    // --- SOFT QUOTA CHECK (95% threshold) ---
                    if (!isApiKey && keys.length > 1) {
                        try {
                            const qRes = await fetch(`${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${keys[currentKeyIndex]}`,
                                    'Content-Type': 'application/json',
                                    ...getAntigravityHeaders()
                                },
                                body: JSON.stringify({ project: DEFAULT_PROJECT_ID })
                            });
                            if (qRes.ok) {
                                const qData = await qRes.json();
                                const modelsObj = qData.models || {};
                                let targetEntry = null;
                                for (const [mName, entry] of Object.entries(modelsObj)) {
                                    if (mName.includes(apiModel) || apiModel.includes(mName)) {
                                        targetEntry = entry;
                                        break;
                                    }
                                }
                                if (targetEntry?.quotaInfo) {
                                    const rf = Number(targetEntry.quotaInfo.remainingFraction || 0);
                                    if (rf <= 0.05) {
                                        throw new Error(`Soft Quota Exceeded: Only ${Math.round(rf*100)}% remaining. Auto-switching to next account.`);
                                    }
                                }
                            }
                        } catch (qErr) {
                            if (qErr.message.includes('Soft Quota')) {
                                throw qErr;
                            }
                        }
                    }
                    // --- END SOFT QUOTA CHECK ---

                    console.log(chalk.cyan(`[API] Request received: Model=${apiModel}, Account=${currentKeyIndex + 1}/${keys.length}, Stream=${stream}`));

                    const fetchRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) });

                    if (!fetchRes.ok) {
                        const errData = await fetchRes.text();
                        throw new Error(`${fetchRes.status} - ${errData}`);
                    }

                    const reader = fetchRes.body.getReader();
                    const decoder = new TextDecoder();
                    let fullText = "";

                    if (stream) {
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.setHeader('Connection', 'keep-alive');
                    }

                    let buffer = "";

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const blocks = buffer.split('data: ');
                        buffer = blocks.pop();

                        for (let block of blocks) {
                            block = block.trim();
                            if (!block || block === '[DONE]') continue;

                            try {
                                const jsonStr = block.split('\n')[0];
                                const parsed = JSON.parse(jsonStr);

                                if (parsed.error) {
                                    throw new Error(`API Error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
                                }

                                const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0] || parsed[0]?.candidates?.[0];

                                if (candidate?.content?.parts) {
                                    for (const part of candidate.content.parts) {
                                        if (part.text) {
                                            fullText += part.text;
                                            if (stream) {
                                                const chunk = {
                                                    id: 'chatcmpl-' + Date.now(),
                                                    object: 'chat.completion.chunk',
                                                    created: Math.floor(Date.now()/1000),
                                                    model: apiModel,
                                                    choices: [{ delta: { content: part.text }, index: 0, finish_reason: null }]
                                                };
                                                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                                if (e.message.includes('API Error')) throw e;
                            }
                        }
                    }

                    if (!fullText.trim()) {
                        throw new Error("Empty response received. Model may be blocked or quota exhausted.");
                    }

                    if (stream) {
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        res.json({
                            id: 'chatcmpl-' + Date.now(),
                            object: 'chat.completion',
                            created: Math.floor(Date.now() / 1000),
                            model: apiModel,
                            choices: [{
                                index: 0,
                                message: { role: 'assistant', content: fullText },
                                finish_reason: 'stop'
                            }],
                            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                        });
                    }

                    success = true;
                    console.log(chalk.green(`[API] Request completed successfully. Model=${apiModel}`));

                } catch (error) {
                    console.error(chalk.yellow(`\n[API Error]: Account-${currentKeyIndex + 1} rejected: `) + chalk.gray(error.message));
                    currentKeyIndex++;
                    if (currentKeyIndex >= keys.length) currentKeyIndex = 0;
                    retryCount++;
                }
            }

            if (!success) {
                if (!res.headersSent) {
                    res.status(500).json({ error: "All tokens exhausted. No successful response received." });
                } else {
                    res.end();
                }
            }

        } catch (globalErr) {
            console.error(chalk.red('[API Fatal Error]'), globalErr);
            if (!res.headersSent) {
                res.status(500).json({ error: globalErr.message });
            }
        }
    });

    app.listen(port, () => {
        console.log(chalk.bgGreen.black(`\n🚀 Antigravity API Server running on port ${port}!\n`));
        console.log(chalk.white(`Endpoint:`), chalk.cyan(`http://localhost:${port}/v1/chat/completions`));
        console.log(chalk.white(`OpenAI-compatible. Works with Cursor, VSCode, and any OpenAI client.`));
        console.log(chalk.gray(`Press Ctrl+C to stop.\n`));
    });
}
