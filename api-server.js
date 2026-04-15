import express from 'express';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { ANTIGRAVITY_SYSTEM_INSTRUCTION, getAntigravityHeaders, setAntigravityVersion } from 'opencode-antigravity-auth/dist/src/constants.js';
import { getValidAccounts, getInstalledAntigravityVersion } from './auth.js';

const CLOUD_CODE_BASE = 'https://daily-cloudcode-pa.sandbox.googleapis.com';

const BACKEND_MODELS = new Set([
    'claude-opus-4-6-thinking',
    'claude-sonnet-4-6',
    'gemini-3.1-pro-high',
    'gemini-3.1-pro-low',
    'gemini-3-flash-agent'
]);

function resolveModel(requested) {
    if (!requested || typeof requested !== 'string') return 'claude-opus-4-6-thinking';
    const lc = requested.toLowerCase();
    if (BACKEND_MODELS.has(lc)) return lc;
    if (lc.includes('opus')) return 'claude-opus-4-6-thinking';
    if (lc.includes('sonnet') || lc.includes('haiku')) return 'claude-sonnet-4-6';
    if (lc.includes('flash')) return 'gemini-3-flash-agent';
    if (lc.includes('gemini')) {
        if (lc.includes('low')) return 'gemini-3.1-pro-low';
        return 'gemini-3.1-pro-high';
    }
    return 'claude-opus-4-6-thinking';
}

export async function startApiServer(port) {
    const detectedVersion = await getInstalledAntigravityVersion();
    if (detectedVersion) {
        setAntigravityVersion(detectedVersion);
        console.log(chalk.gray(`[Init] Antigravity version set to ${detectedVersion} (from installed IDE)`));
    }

    const app = express();
    app.use(express.json({ limit: '50mb' }));

    // Returns { keys, projects } where keys[i] is access_token and projects[i] is project_id for that account.
    const getKeys = async () => {
        const accounts = await getValidAccounts();
        return {
            keys: accounts.map(a => a.access_token),
            projects: accounts.map(a => a.project_id)
        };
    };

    let currentKeyIndex = 0;

    app.post('/v1/chat/completions', async (req, res) => {
        try {
            const { keys, projects } = await getKeys();
            if (keys.length === 0) {
                return res.status(401).json({ error: "No auth tokens found. Run 'node index.js login' first." });
            }

            const { messages = [], stream = false, temperature = 0.7 } = req.body;
            const model = resolveModel(req.body.model);
            console.log(chalk.gray(`[API /v1/chat/completions] requested=${req.body.model || '(none)'} resolved=${model}`));
            
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

            // Merge consecutive same-role messages so Vertex AI doesn't squash them
            const mergedParts = [];
            for (const part of conversationParts) {
                if (mergedParts.length > 0 && mergedParts[mergedParts.length - 1].role === part.role) {
                    mergedParts[mergedParts.length - 1].parts[0].text += '\n' + part.parts[0].text;
                } else {
                    mergedParts.push(part);
                }
            }
            conversationParts = mergedParts;

            if (conversationParts.length === 0) {
                return res.status(400).json({ error: "No valid prompt found in messages array." });
            }

            // Extract system prompt (can be string or array of content blocks)
            let finalSystem = '';
            if (systemMsg) finalSystem = systemMsg;

            let success = false;
            let retryCount = 0;
            let currentModel = model;
            const maxRetries = keys.length;
            let hasTriedFallback = false;

            while (!success && retryCount < maxRetries) {
                try {
                    const isApiKey = keys[currentKeyIndex] && keys[currentKeyIndex].startsWith('AIza');
                    const apiModel = currentModel.replace(/^antigravity-/i, '');
                    const DEFAULT_PROJECT_ID = projects[currentKeyIndex];
                    
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
                                systemInstruction: finalSystem ? { parts: [{ text: finalSystem }] } : undefined,
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
                                
                                for (const [mName, entry] of Object.entries(modelsObj)) {
                                    if ((mName.includes(apiModel) || apiModel.includes(mName)) && entry?.quotaInfo) {
                                        const rf = Number(entry.quotaInfo.remainingFraction || 0);
                                        if (rf <= 0.05) {
                                            throw new Error(`Soft Quota Exceeded: Only ${Math.round(rf*100)}% remaining.`);
                                        }
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

                    let inThoughtBlock = false;

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
                                        let textChunk = '';
                                        let isThought = false;

                                        if (typeof part.thought === 'string') {
                                            isThought = true;
                                            textChunk = part.thought;
                                        } else if (part.text) {
                                            textChunk = part.text;
                                            if (part.thought === true || part.isThought === true) {
                                                isThought = true;
                                            }
                                        }

                                        if (textChunk) {
                                            fullText += textChunk;
                                            if (stream) {
                                                const deltaObj = isThought 
                                                    ? { reasoning_content: textChunk } 
                                                    : { content: textChunk };
                                                    
                                                const chunk = {
                                                    id: 'chatcmpl-' + Date.now(),
                                                    object: 'chat.completion.chunk',
                                                    created: Math.floor(Date.now()/1000),
                                                    model: apiModel,
                                                    choices: [{ delta: deltaObj, index: 0, finish_reason: null }]
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

    // --- /v1/responses endpoint (OpenAI Codex compatibility) ---
    app.post('/v1/responses', async (req, res) => {
        try {
            const { keys, projects } = await getKeys();
            if (keys.length === 0) {
                return res.status(401).json({ error: { message: "No auth tokens found. Run 'node index.js login' first." }});
            }

            const { input = '', instructions = '', stream = false, max_output_tokens = 8192, temperature = 0.7 } = req.body;
            const model = resolveModel(req.body.model);

            // Build prompt from input (can be string or array of messages)
            let conversationParts = [];
            let systemPrompt = instructions || '';

            if (typeof input === 'string') {
                conversationParts.push({ role: 'user', parts: [{ text: input }] });
            } else if (Array.isArray(input)) {
                for (const item of input) {
                    if (typeof item === 'string') {
                        conversationParts.push({ role: 'user', parts: [{ text: item }] });
                    } else if (item.role && item.content) {
                        let text = '';
                        if (typeof item.content === 'string') {
                            text = item.content;
                        } else if (Array.isArray(item.content)) {
                            text = item.content.filter(b => b.type === 'input_text' || b.type === 'text').map(b => b.text).join('\n');
                        }
                        if (item.role === 'system') {
                            systemPrompt = text || systemPrompt;
                        } else if (text) {
                            const mappedRole = (item.role === 'assistant' || item.role === 'model') ? 'model' : 'user';
                            conversationParts.push({ role: mappedRole, parts: [{ text }] });
                        }
                    }
                }
            }

            // Merge consecutive same-role messages so Vertex AI doesn't squash them or reject them
            const mergedParts = [];
            for (const part of conversationParts) {
                if (mergedParts.length > 0 && mergedParts[mergedParts.length - 1].role === part.role) {
                    mergedParts[mergedParts.length - 1].parts[0].text += '\n' + part.parts[0].text;
                } else {
                    mergedParts.push(part);
                }
            }
            conversationParts = mergedParts;

            if (conversationParts.length === 0) {
                return res.status(400).json({ error: { message: 'No valid input found.' }});
            }

            let success = false;
            let retryCount = 0;
            let currentModel = model;
            const maxRetries = keys.length;
            let hasTriedFallback = false;

            while (!success && retryCount < maxRetries) {
                try {
                    const agentHeaders = getAntigravityHeaders();
                    const DEFAULT_PROJECT_ID = projects[currentKeyIndex];
                    const apiModel = currentModel.replace(/^antigravity-/i, '');

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
                            systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
                            generationConfig: { temperature, maxOutputTokens: max_output_tokens,
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
                                        const rf = Number(entry.quotaInfo.remainingFraction || 0);
                                        if (rf <= 0.05) {
                                            throw new Error(`Soft Quota Exceeded: Only ${Math.round(rf*100)}% remaining.`);
                                        }
                                    }
                                }
                            }
                        } catch (qErr) { if (qErr.message.includes('Soft Quota')) throw qErr; }
                    }

                    console.log(chalk.cyan(`[API /v1/responses] Request received: Model=${apiModel}, Account=${currentKeyIndex + 1}/${keys.length}, Stream=${stream}`));

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
                        // Send response.created event
                        const respId = 'resp_' + Date.now();
                        res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: respId, object: 'response', status: 'in_progress', output: [] }})}\n\n`);
                        res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] }})}\n\n`);
                        res.write(`event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' }})}\n\n`);
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
                                        let textChunk = '';
                                        let isThought = false;

                                        if (typeof part.thought === 'string') {
                                            isThought = true;
                                        } else if (part.text) {
                                            if (part.thought === true || part.isThought === true) {
                                                isThought = true;
                                            } else {
                                                textChunk = part.text;
                                            }
                                        }

                                        // Sadece düşünce (thought) olmayan kısımları Codex için output'a dahil et
                                        if (!isThought && textChunk) {
                                            fullText += textChunk;
                                            if (stream) {
                                                res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: textChunk })}\n\n`);
                                            }
                                        }
                                    }
                                }
                            } catch (e) { if (e.message.includes('API Error')) throw e; }
                        }
                    }

                    if (!fullText.trim()) throw new Error('Empty response');

                    if (stream) {
                        res.write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: fullText })}\n\n`);
                        res.write(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText }})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: fullText }] }})}\n\n`);
                        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_' + Date.now(), object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: fullText }] }], usage: { input_tokens: 0, output_tokens: fullText.length, total_tokens: fullText.length } }})}\n\n`);
                        res.end();
                    } else {
                        res.json({
                            id: 'resp_' + Date.now(),
                            object: 'response',
                            status: 'completed',
                            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: fullText }] }],
                            usage: { input_tokens: 0, output_tokens: fullText.length, total_tokens: fullText.length }
                        });
                    }

                    success = true;
                    console.log(chalk.green(`[API /v1/responses] Request completed successfully.`));

                } catch (error) {
                    console.error(chalk.yellow(`\n[API Error]: Account-${currentKeyIndex + 1} rejected: `) + chalk.gray(error.message));
                    currentKeyIndex++;
                    if (currentKeyIndex >= keys.length) currentKeyIndex = 0;
                    retryCount++;

                    if (retryCount >= maxRetries && !hasTriedFallback && (currentModel.includes('claude-opus-') || currentModel.includes('claude-sonnet-'))) {
                        console.log(chalk.magenta(`\n[Fallback] All accounts exhausted for ${currentModel}. Falling back to gemini-3.1-pro-high...`));
                        currentModel = 'gemini-3.1-pro-high';
                        retryCount = 0;
                        hasTriedFallback = true;
                    }
                }
            }

            if (!success && !res.headersSent) {
                res.status(500).json({ error: { message: 'All tokens exhausted.' }});
            }
        } catch (globalErr) {
            console.error(chalk.red('[API Fatal Error]'), globalErr);
            if (!res.headersSent) {
                res.status(500).json({ error: { message: globalErr.message }});
            }
        }
    });

    // Claude Code CLI probes this on startup to validate the selected model.
    // Exact counts aren't required — it only needs a 200 with `input_tokens`.
    app.post('/v1/messages/count_tokens', (req, res) => {
        try {
            const { messages = [], system = '', tools = [] } = req.body || {};
            let chars = 0;

            const addText = (v) => {
                if (v == null) return;
                if (typeof v === 'string') { chars += v.length; return; }
                if (Array.isArray(v)) { v.forEach(addText); return; }
                if (typeof v === 'object') {
                    if (typeof v.text === 'string') chars += v.text.length;
                    if (typeof v.content === 'string') chars += v.content.length;
                    else if (Array.isArray(v.content)) v.content.forEach(addText);
                    if (v.input && typeof v.input === 'object') chars += JSON.stringify(v.input).length;
                }
            };

            addText(system);
            messages.forEach(m => addText(m?.content));
            if (Array.isArray(tools)) {
                tools.forEach(t => {
                    if (t?.name) chars += String(t.name).length;
                    if (t?.description) chars += String(t.description).length;
                    if (t?.input_schema) chars += JSON.stringify(t.input_schema).length;
                });
            }

            res.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)) });
        } catch (e) {
            res.status(500).json({ type: 'error', error: { type: 'api_error', message: e.message }});
        }
    });

    // --- /v1/messages endpoint (Anthropic/Claude Code CLI compatibility) ---
    app.post('/v1/messages', async (req, res) => {
        try {
            const { keys, projects } = await getKeys();
            if (keys.length === 0) {
                return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: "No auth tokens found. Run 'node index.js login' first." }});
            }

            const { messages = [], system = '', tools = undefined, stream = false, max_tokens = 8192, temperature = 0.7 } = req.body;
            const model = resolveModel(req.body.model);
            console.log(chalk.gray(`[API /v1/messages] requested=${req.body.model || '(none)'} resolved=${model} max_tokens=${max_tokens} stream=${stream}`));

            // Anthropic -> Gemini Tools translation
            let geminiTools = undefined;
            if (tools && Array.isArray(tools) && tools.length > 0) {
                // Gemini is very strict about OpenAPI schemas. We must strip unsupported fields
                const cleanSchema = (obj, isPropertiesMap = false) => {
                    if (!obj || typeof obj !== 'object') return obj;
                    if (Array.isArray(obj)) return obj.map(x => cleanSchema(x));
                    
                    const cleaned = {};
                    const allowedKeys = ['type', 'description', 'properties', 'required', 'items', 'enum'];
                    
                    for (const [k, v] of Object.entries(obj)) {
                        if (isPropertiesMap) {
                            // If inside 'properties', 'k' is the property name, 'v' is the schema object
                            cleaned[k] = cleanSchema(v, false);
                        } else {
                            if (allowedKeys.includes(k)) {
                                if (k === 'type') {
                                    if (Array.isArray(v)) {
                                        cleaned[k] = (v.find(t => t !== 'null') || 'STRING').toUpperCase();
                                    } else if (typeof v === 'string') {
                                        cleaned[k] = v.toUpperCase(); 
                                    }
                                } else if (k === 'properties') {
                                    cleaned[k] = cleanSchema(v, true); // Next level is a map of property schemas
                                } else {
                                    cleaned[k] = cleanSchema(v, false);
                                }
                            }
                        }
                    }
                    if (!isPropertiesMap) {
                        if (cleaned.properties && !cleaned.type) cleaned.type = 'OBJECT';
                        if (!cleaned.type && !cleaned.properties && !cleaned.items) cleaned.type = 'STRING'; 
                    }
                    return cleaned;
                };

                geminiTools = [{
                    functionDeclarations: tools.map(t => {
                        let schema = t.input_schema ? cleanSchema(t.input_schema) : { type: 'OBJECT', properties: {} };
                        if (!schema.type) schema.type = 'OBJECT';
                        return { name: t.name, description: t.description || '', parameters: schema };
                    })
                }];
            }

            // DEBUG: Log what Claude Code is actually sending
            console.log(chalk.magenta(`[DEBUG] system type: ${typeof system}, isArray: ${Array.isArray(system)}, length: ${typeof system === 'string' ? system.length : JSON.stringify(system).length}`));
            if (typeof system === 'string' && system.length > 0) {
                console.log(chalk.magenta(`[DEBUG] system preview: ${system.substring(0, 200)}...`));
            } else if (Array.isArray(system)) {
                console.log(chalk.magenta(`[DEBUG] system array items: ${system.length}, first type: ${system[0]?.type}`));
                const firstText = system.find(b => b.type === 'text')?.text || '';
                console.log(chalk.magenta(`[DEBUG] system preview: ${firstText.substring(0, 200)}...`));
            }
            console.log(chalk.magenta(`[DEBUG] req.body keys: ${Object.keys(req.body).join(', ')}`));

            let conversationParts = [];
            let toolIdToName = {};

            for (const msg of messages) {
                let parts = [];
                if (typeof msg.content === 'string') {
                    parts.push({ text: msg.content });
                } else if (Array.isArray(msg.content)) {
                    for (const b of msg.content) {
                        if (b.type === 'text') {
                            parts.push({ text: b.text });
                        } else if (b.type === 'tool_use') {
                            toolIdToName[b.id] = b.name;
                            parts.push({ functionCall: { id: b.id, name: b.name, args: b.input } });
                        } else if (b.type === 'tool_result') {
                            const funcName = toolIdToName[b.tool_use_id] || "unknown_tool";
                            let resultStr = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                            parts.push({ functionResponse: { id: b.tool_use_id, name: funcName, response: { content: resultStr } } });
                        }
                    }
                }
                const mappedRole = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user';
                if (parts.length > 0) {
                    conversationParts.push({ role: mappedRole, parts });
                }
            }

            // Merge consecutive same-role messages so Vertex AI doesn't squash text blindly or reject structure
            const mergedParts = [];
            for (const part of conversationParts) {
                if (mergedParts.length > 0 && mergedParts[mergedParts.length - 1].role === part.role) {
                    // Combine parts of the same role
                    mergedParts[mergedParts.length - 1].parts.push(...part.parts);
                } else {
                    mergedParts.push(part);
                }
            }
            conversationParts = mergedParts;

            if (conversationParts.length === 0) {
                return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'No valid prompt found.' }});
            }

            // Extract system prompt (can be string or array of content blocks)
            let finalSystemPrompt = '';
            if (typeof system === 'string') {
                finalSystemPrompt = system;
            } else if (Array.isArray(system)) {
                finalSystemPrompt = system.filter(b => b.type === 'text').map(b => b.text).join('\n');
            }

            let success = false;
            let retryCount = 0;
            let currentModel = model;
            const maxRetries = keys.length;
            let hasTriedFallback = false;

            while (!success && retryCount < maxRetries) {
                try {
                    const agentHeaders = getAntigravityHeaders();
                    const DEFAULT_PROJECT_ID = projects[currentKeyIndex];
                    const apiModel = currentModel.replace(/^antigravity-/i, '');

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
                            tools: geminiTools,
                            systemInstruction: finalSystemPrompt ? { parts: [{ text: finalSystemPrompt }] } : undefined,
                            generationConfig: { temperature, maxOutputTokens: max_tokens }
                        }
                    };

                    if (apiModel.includes('thinking') || apiModel.includes('gemini-3')) {
                        if (apiModel.includes('claude') || apiModel.includes('sonnet')) {
                            const budget = Math.max(1024, Math.min(8192, Math.floor(max_tokens / 2)));
                            requestBody.request.generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
                        } else {
                            let level = 'medium';
                            if (apiModel.includes('low')) level = 'low';
                            if (apiModel.includes('high')) level = 'high';
                            requestBody.request.generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
                        }
                    }

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
                                        const rf = Number(entry.quotaInfo.remainingFraction || 0);
                                        if (rf <= 0.05) {
                                            throw new Error(`Soft Quota Exceeded: Only ${Math.round(rf*100)}% remaining.`);
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
                    let hasStartedText = false;
                    let blockIndex = 0;
                    let stopReason = 'end_turn';
                    let collectedTools = [];
                    let receivedCandidate = false;

                    // Gemini finishReason -> Anthropic stop_reason. Called whenever a candidate arrives.
                    const mapFinishReason = (fr) => {
                        if (!fr) return null;
                        if (fr === 'STOP') return 'end_turn';
                        if (fr === 'MAX_TOKENS') return 'max_tokens';
                        if (fr === 'SAFETY' || fr === 'RECITATION' || fr === 'BLOCKLIST') return 'stop_sequence';
                        return 'end_turn';
                    };

                    if (stream) {
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.setHeader('Connection', 'keep-alive');
                        const msgId = 'msg_' + Date.now();
                        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: apiModel, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 }}})}\n\n`);
                    }

                    let inThoughtBlock = false;

                    const processBlock = (block) => {
                        block = block.trim();
                        if (!block || block === '[DONE]') return;
                        try {
                            const parsed = JSON.parse(block.split('\n')[0]);
                            if (parsed.error) throw new Error(`API Error: ${parsed.error.message}`);
                            const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0];
                            if (candidate) receivedCandidate = true;
                            const mapped = mapFinishReason(candidate?.finishReason);
                            if (mapped) stopReason = mapped;
                            if (!candidate?.content?.parts) return;
                            for (const part of candidate.content.parts) {
                                let textChunk = '';
                                let isThought = false;

                                if (typeof part.thought === 'string') {
                                    isThought = true;
                                    textChunk = part.thought;
                                } else if (part.text) {
                                    textChunk = part.text;
                                    if (part.thought === true || part.isThought === true) {
                                        isThought = true;
                                    }
                                }

                                if (textChunk) {
                                    let formattedChunk = '';

                                    if (isThought && !inThoughtBlock) {
                                        inThoughtBlock = true;
                                        formattedChunk = '<think>\n' + textChunk;
                                    } else if (!isThought && inThoughtBlock) {
                                        inThoughtBlock = false;
                                        formattedChunk = '\n</think>\n\n' + textChunk;
                                    } else {
                                        formattedChunk = textChunk;
                                    }

                                    fullText += formattedChunk;
                                    if (stream) {
                                        if (!hasStartedText) {
                                            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' }})}\n\n`);
                                            hasStartedText = true;
                                        }
                                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: formattedChunk }})}\n\n`);
                                    }
                                } else if (part.functionCall) {
                                    const funcName = part.functionCall.name;
                                    const argsObj = part.functionCall.args || {};
                                    const argsStr = JSON.stringify(argsObj);
                                    const toolId = part.functionCall.id || ('toolu_' + Date.now() + Math.random().toString(36).substring(7));
                                    collectedTools.push({ type: 'tool_use', id: toolId, name: funcName, input: argsObj });

                                    if (stream) {
                                        if (hasStartedText) {
                                            if (inThoughtBlock) {
                                                fullText += '\n</think>\n\n';
                                                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '\n</think>\n\n' }})}\n\n`);
                                                inThoughtBlock = false;
                                            }
                                            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
                                            blockIndex++;
                                            hasStartedText = false;
                                        }
                                        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: toolId, name: funcName, input: {} } })}\n\n`);
                                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: argsStr } })}\n\n`);
                                        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
                                        blockIndex++;
                                        stopReason = 'tool_use';
                                    }
                                }
                            }
                        } catch (e) { if (e.message.includes('API Error')) throw e; }
                    };

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const blocks = buffer.split('data: ');
                        buffer = blocks.pop();
                        for (let block of blocks) processBlock(block);
                    }
                    // Flush any trailing complete block the while-loop left in buffer.
                    if (buffer) processBlock(buffer);

                    if (inThoughtBlock) {
                        fullText += '\n</think>\n\n';
                        if (stream && hasStartedText) {
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '\n</think>\n\n' }})}\n\n`);
                        }
                    }

                    if (!receivedCandidate) throw new Error('Empty response (no candidates from backend)');
                    if (!fullText.trim() && collectedTools.length === 0) {
                        console.log(chalk.yellow(`[API /v1/messages] Empty text but valid candidate (stop_reason=${stopReason}). Returning empty message.`));
                    }

                    if (stream) {
                        if (hasStartedText) {
                            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
                        }
                        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: fullText.length }})}\n\n`);
                        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                        res.end();
                    } else {
                        const finalContent = [];
                        if (fullText.trim()) finalContent.push({ type: 'text', text: fullText });
                        collectedTools.forEach(t => finalContent.push(t));

                        res.json({
                            id: 'msg_' + Date.now(),
                            type: 'message',
                            role: 'assistant',
                            content: finalContent,
                            model: apiModel,
                            stop_reason: stopReason,
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

                    if (retryCount >= maxRetries && !hasTriedFallback && (currentModel.includes('claude-opus-') || currentModel.includes('claude-sonnet-'))) {
                        console.log(chalk.magenta(`\n[Fallback] All accounts exhausted for ${currentModel}. Falling back to gemini-3.1-pro-high...`));
                        currentModel = 'gemini-3.1-pro-high';
                        retryCount = 0;
                        hasTriedFallback = true;
                    }
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
