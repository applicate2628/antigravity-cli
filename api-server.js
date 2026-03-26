import express from 'express';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { ANTIGRAVITY_SYSTEM_INSTRUCTION, getAntigravityHeaders } from 'opencode-antigravity-auth/dist/src/constants.js';
import { getValidTokens } from './auth.js';

export async function startApiServer(port) {
    const app = express();
    app.use(express.json({ limit: '50mb' }));

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
            
            // Extract system message and build conversation
            const systemMsg = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
            let conversationParts = [];
            for (const msg of messages) {
                if (msg.role === 'system') continue; // handled separately
                const text = typeof msg.content === 'string' ? msg.content : 
                    Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
                if (text) {
                    conversationParts.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
                }
            }

            if (conversationParts.length === 0) {
                return res.status(400).json({ error: "No valid prompt found in messages array." });
            }

            // Combine system messages
            const combinedSystem = systemMsg
                ? `${ANTIGRAVITY_SYSTEM_INSTRUCTION}\n\n--- Client System Prompt ---\n${systemMsg}`
                : ANTIGRAVITY_SYSTEM_INSTRUCTION;

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
                            contents: conversationParts,
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
                                contents: conversationParts,
                                systemInstruction: { parts: [{ text: combinedSystem }] },
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

    // --- /v1/models endpoint (for Claude Code / tool validation) ---
    app.get('/v1/models', (req, res) => {
        res.json({
            object: 'list',
            data: [
                { id: 'claude-opus-4-6-thinking', object: 'model', created: 1700000000, owned_by: 'antigravity' },
                { id: 'claude-sonnet-4-6', object: 'model', created: 1700000000, owned_by: 'antigravity' },
                { id: 'gemini-3.1-pro-high', object: 'model', created: 1700000000, owned_by: 'antigravity' },
                { id: 'gemini-3.1-pro-low', object: 'model', created: 1700000000, owned_by: 'antigravity' },
                { id: 'gemini-3-flash-agent', object: 'model', created: 1700000000, owned_by: 'antigravity' },
            ]
        });
    });

    // --- /v1/messages endpoint (Anthropic/Claude Code CLI compatibility) ---
    app.post('/v1/messages', async (req, res) => {
        try {
            const keys = await getKeys();
            if (keys.length === 0) {
                return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: "No auth tokens found. Run 'node index.js login' first." }});
            }

            const { messages = [], system = '', stream = false, max_tokens = 8192, temperature = 0.7 } = req.body;
            const model = 'claude-opus-4-6-thinking';

            // Build conversation contents from all messages
            let conversationParts = [];
            for (const msg of messages) {
                let text = '';
                if (typeof msg.content === 'string') {
                    text = msg.content;
                } else if (Array.isArray(msg.content)) {
                    text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
                }
                if (text) {
                    conversationParts.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
                }
            }

            if (conversationParts.length === 0) {
                return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'No valid prompt found.' }});
            }

            // Combine Claude Code's system prompt with Antigravity's required system instruction
            const combinedSystemPrompt = system
                ? `${ANTIGRAVITY_SYSTEM_INSTRUCTION}\n\n--- Client System Prompt ---\n${system}`
                : ANTIGRAVITY_SYSTEM_INSTRUCTION;

            let success = false;
            let retryCount = 0;
            const maxRetries = keys.length;

            while (!success && retryCount < maxRetries) {
                try {
                    const agentHeaders = getAntigravityHeaders();
                    const CLOUD_CODE_BASE = 'https://cloudcode-pa.googleapis.com';
                    const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
                    const apiModel = model.replace(/^antigravity-/i, '');

                    const url = `${CLOUD_CODE_BASE}/v1internal:streamGenerateContent?alt=sse`;
                    const headers = {
                        'Authorization': `Bearer ${keys[currentKeyIndex]}`,
                        'Content-Type': 'application/json',
                        ...agentHeaders
                    };

                    const requestBody = {
                        project: DEFAULT_PROJECT_ID,
                        model: apiModel,
                        request: {
                            contents: conversationParts,
                            systemInstruction: { parts: [{ text: combinedSystemPrompt }] },
                            generationConfig: { temperature, maxOutputTokens: max_tokens,
                                thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 }
                            }
                        }
                    };

                    // Soft Quota Check
                    if (keys.length > 1) {
                        try {
                            const qRes = await fetch(`${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`, {
                                method: 'POST',
                                headers: { 'Authorization': `Bearer ${keys[currentKeyIndex]}`, 'Content-Type': 'application/json', ...getAntigravityHeaders() },
                                body: JSON.stringify({ project: DEFAULT_PROJECT_ID })
                            });
                            if (qRes.ok) {
                                const qData = await qRes.json();
                                const modelsObj = qData.models || {};
                                for (const [mName, entry] of Object.entries(modelsObj)) {
                                    if ((mName.includes(apiModel) || apiModel.includes(mName)) && entry?.quotaInfo) {
                                        if (Number(entry.quotaInfo.remainingFraction || 0) <= 0.05) {
                                            throw new Error('Soft Quota Exceeded');
                                        }
                                    }
                                }
                            }
                        } catch (qErr) { if (qErr.message.includes('Soft Quota')) throw qErr; }
                    }

                    console.log(chalk.cyan(`[API /v1/messages] Request received: Model=${apiModel}, Account=${currentKeyIndex + 1}/${keys.length}, Stream=${stream}`));

                    const fetchRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) });
                    if (!fetchRes.ok) throw new Error(`${fetchRes.status} - ${await fetchRes.text()}`);

                    const reader = fetchRes.body.getReader();
                    const decoder = new TextDecoder();
                    let fullText = '';
                    let buffer = '';

                    if (stream) {
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.setHeader('Connection', 'keep-alive');
                        // Send initial message_start event
                        const msgId = 'msg_' + Date.now();
                        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: apiModel, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 }}})}\n\n`);
                        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }})}\n\n`);
                    }

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
                                const parsed = JSON.parse(block.split('\n')[0]);
                                if (parsed.error) throw new Error(`API Error: ${parsed.error.message}`);
                                const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0];
                                if (candidate?.content?.parts) {
                                    for (const part of candidate.content.parts) {
                                        if (part.text) {
                                            fullText += part.text;
                                            if (stream) {
                                                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part.text }})}\n\n`);
                                            }
                                        }
                                    }
                                }
                            } catch (e) { if (e.message.includes('API Error')) throw e; }
                        }
                    }

                    if (!fullText.trim()) throw new Error('Empty response');

                    if (stream) {
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: fullText.length }})}\n\n`);
                        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                        res.end();
                    } else {
                        res.json({
                            id: 'msg_' + Date.now(),
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'text', text: fullText }],
                            model: apiModel,
                            stop_reason: 'end_turn',
                            usage: { input_tokens: 0, output_tokens: fullText.length }
                        });
                    }

                    success = true;
                    console.log(chalk.green(`[API /v1/messages] Request completed successfully.`));

                } catch (error) {
                    console.error(chalk.yellow(`[API Error]: Account-${currentKeyIndex + 1} rejected: `) + chalk.gray(error.message));
                    currentKeyIndex++;
                    if (currentKeyIndex >= keys.length) currentKeyIndex = 0;
                    retryCount++;
                }
            }

            if (!success && !res.headersSent) {
                res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'All tokens exhausted.' }});
            }
        } catch (globalErr) {
            console.error(chalk.red('[API Fatal Error]'), globalErr);
            if (!res.headersSent) {
                res.status(500).json({ type: 'error', error: { type: 'api_error', message: globalErr.message }});
            }
        }
    });

    app.listen(port, () => {
        console.log(chalk.bgGreen.black(`\n🚀 Antigravity API Server running on port ${port}!\n`));
        console.log(chalk.white(`Endpoints:`));
        console.log(chalk.cyan(`  OpenAI:     http://localhost:${port}/v1/chat/completions`));
        console.log(chalk.cyan(`  Anthropic:  http://localhost:${port}/v1/messages`));
        console.log(chalk.cyan(`  Models:     http://localhost:${port}/v1/models`));
        console.log(chalk.white(`\nCompatible with Cursor, VSCode, Claude Code, Aider, and any OpenAI/Anthropic client.`));
        console.log(chalk.gray(`Press Ctrl+C to stop.\n`));
    });
}
