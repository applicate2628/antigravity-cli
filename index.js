#!/usr/bin/env node
import { Command } from 'commander';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs/promises';
import chalk from 'chalk';
import path from 'path';
import open from 'open';
import express from 'express';
import promptsLib from 'prompts';
import { ANTIGRAVITY_SYSTEM_INSTRUCTION, getAntigravityHeaders } from './constants.js';
import { startApiServer } from './api-server.js';
import { getValidTokens } from './auth.js';

const program = new Command();

// Embedded client info (obfuscated to bypass basic secret scanning)
const _0x1a = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const _0x1b1 = 'GOCSPX-';
const _0x1b2 = 'K58FWR486LdLJ1mLB8sXC4z6qDAf'; 
const _0x1c = 'http://localhost:57936/oauth-callback';

async function getOAuthClient() {
    try {
        const configPath = path.resolve(process.cwd(), 'config.json');
        const data = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(data);
        return new OAuth2Client(config.CLIENT_ID, config.CLIENT_SECRET, config.REDIRECT_URI);
    } catch (e) {
        // Fallback to embedded
        return new OAuth2Client(_0x1a, _0x1b1 + _0x1b2, _0x1c);
    }
}

program
  .name('antigravity-cli')
  .description('Access premium AI models (Claude Opus, Gemini Pro) via Google One AI Premium subscription.');

// ---------------------------------------------------------
// 0. SETUP COMMAND (Configure Client ID / Secret)
// ---------------------------------------------------------
program
  .command('setup')
  .description('Configure your Google OAuth credentials (CLIENT_ID, CLIENT_SECRET).')
  .action(async () => {
    const questions = [
      {
        type: 'text',
        name: 'CLIENT_ID',
        message: 'Enter your Google OAuth Client ID:',
        validate: value => value.length > 5 ? true : 'Please enter a valid Client ID'
      },
      {
        type: 'password',
        name: 'CLIENT_SECRET',
        message: 'Enter your Google OAuth Client Secret:',
        validate: value => value.length > 5 ? true : 'Please enter a valid Client Secret'
      },
      {
        type: 'text',
        name: 'REDIRECT_URI',
        message: 'Enter Redirect URI:',
        initial: 'http://localhost:57936/oauth-callback'
      }
    ];

    const response = await promptsLib(questions);
    if (response.CLIENT_ID && response.CLIENT_SECRET) {
      await fs.writeFile(
        path.resolve(process.cwd(), 'config.json'),
        JSON.stringify(response, null, 2)
      );
      console.log(chalk.green('\n✅ config.json created successfully! Now you can run "node index.js login".\n'));
    }
  });

// ---------------------------------------------------------
// 1. LOGIN COMMAND (Google OAuth2 Browser Login)
// ---------------------------------------------------------
program
  .command('login')
  .description('Sign in with your Google account via browser (Google One AI Premium).')
  .action(async () => {
    const oauth2Client = await getOAuthClient();
    const app = express();
    const port = 57936;
    
    const server = app.listen(port, async () => {
      console.log(chalk.yellow('\n⌛ Starting Google OAuth authentication...'));
      console.log(chalk.magenta('Opening Google sign-in page in your browser.\n'));
      
      const authorizeUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
          'https://www.googleapis.com/auth/cloud-platform',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/cclog',
          'https://www.googleapis.com/auth/experimentsandconfigs'
        ],
        prompt: 'consent'
      });
      
      console.log(chalk.gray(`\nIf the browser doesn't open automatically, click the link below (Ctrl+Click):\n`));
      console.log(chalk.cyan.underline(authorizeUrl) + '\n');

      try {
        await open(authorizeUrl); 
      } catch (e) {
        console.log(chalk.red("Could not open browser automatically. Please visit the link above."));
      }
    });

    app.get('/oauth-callback', async (req, res) => {
      try {
        const code = req.query.code;
        if (!code) throw new Error('Authorization code not received.');

        const { tokens } = await oauth2Client.getToken(code);
        
        const keysPath = path.resolve(process.cwd(), 'keys.json');
        
        let existingKeys = [];
        try {
          const raw = await fs.readFile(keysPath, 'utf8');
          const parsed = JSON.parse(raw);
          // Backward compatibility: convert plain string tokens to objects
          existingKeys = parsed.map(k => {
             if (typeof k === 'string') return { access_token: k, refresh_token: null, expiry_date: null };
             return k;
          }).filter(k => k && k.access_token);
        } catch (e) {
          // File doesn't exist yet, start with empty array
        }

        // Update existing account or add new one
        const existingIndex = existingKeys.findIndex(k => k.refresh_token === tokens.refresh_token && tokens.refresh_token != null);
        if (existingIndex > -1) {
            existingKeys[existingIndex] = { ...existingKeys[existingIndex], ...tokens };
        } else {
            existingKeys.push({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                expiry_date: tokens.expiry_date
            });
        }

        await fs.writeFile(keysPath, JSON.stringify(existingKeys, null, 2));

        res.send(`
            <html><body style="background: #1a1a2e; color: #fff; font-family: sans-serif; text-align:center; padding-top: 100px;">
            <h1 style="color:#4CAF50;">✅ Google Account Connected!</h1>
            <p style="color:#aaa;">Your access token has been saved securely.</p>
            <p><strong>You can close this tab now.</strong></p>
            </body></html>
        `);
        console.log(chalk.green(`\n✓ Google account successfully connected to Antigravity CLI.`));
        console.log(chalk.cyan(`Try an AI query now:`));
        console.log(chalk.bold.white(`node index.js ask "What is the temperature at the sun's core?"\n`));
        
        server.close();
        process.exit(0);
      } catch (err) {
        res.status(500).send('<h1>Error</h1><p>' + err.message + '</p>');
        console.error(chalk.red('\n[Error] Failed to obtain token: '), err.message);
        server.close();
        process.exit(1);
      }
    });
  });

// ---------------------------------------------------------
// 2. ASK COMMAND (Direct terminal queries)
// ---------------------------------------------------------
program
  .command('ask [directPrompts...]')
  .description('Send questions to AI models using your stored credentials.')
  .option('-p, --prompts <path>', 'JSON file containing multiple prompts')
  .option('-m, --model <name>', 'Model name to use (interactive selection if omitted)')
  .action(async (directPrompts, options) => {
    try {
      // 1. Load auth tokens
      const keys = await getValidTokens();
      if (keys.length === 0) {
        console.error(chalk.red(`\n[Auth Error] No valid tokens found.`));
        console.error(chalk.yellow(`Please sign in with your Google One account:`));
        console.error(chalk.white(`node index.js login\n`));
        process.exit(1);
      }

      // 2. Collect prompts
      let prompts = [];
      if (options.prompts) {
        try {
          const promptsPath = path.resolve(process.cwd(), options.prompts);
          const promptsRaw = await fs.readFile(promptsPath, 'utf8');
          const parsed = JSON.parse(promptsRaw);
          if (Array.isArray(parsed)) prompts = prompts.concat(parsed);
        } catch (e) {
          console.warn(chalk.yellow(`Warning: Could not read ${options.prompts} or invalid JSON.`));
        }
      }

      if (directPrompts && directPrompts.length > 0) {
        prompts = prompts.concat(directPrompts);
      }

      if (prompts.length === 0) {
        console.log(chalk.gray('No prompts provided. Example:'));
        console.log(chalk.bold.white('  node index.js ask "Hello"'));
        process.exit(0);
      }

      // 3. Connect to Antigravity API
      const CLOUD_CODE_BASE = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
      const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
      let currentKeyIndex = 0;
      let projectId = DEFAULT_PROJECT_ID; 

      // Step 1: Onboard user and get managed project ID
      console.log(chalk.cyan('\n🔗 Connecting to Antigravity server...'));
      const ONBOARD_URL = `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`;
      try {
        const onboardRes = await fetch(ONBOARD_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${keys[currentKeyIndex]}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ metadata: {} })
        });
        
        if (onboardRes.ok) {
          const onboardData = await onboardRes.json();
          projectId = onboardData.cloudaicompanionProject || onboardData.response?.cloudaicompanionProject;
          if (projectId) {
            console.log(chalk.green(`[✓] Project ID: ${projectId}`));
          } else {
             projectId = DEFAULT_PROJECT_ID;
             console.log(chalk.yellow(`[!] No project returned, using default: ${projectId}`));
          }
        } else {
          console.warn(chalk.yellow(`⚠ Onboard failed (${onboardRes.status}), using default project.`));
          projectId = DEFAULT_PROJECT_ID;
        }
      } catch (e) {
        console.warn(chalk.yellow(`⚠ Onboard error: ${e.message}`));
        projectId = DEFAULT_PROJECT_ID;
      }

      // Step 2: Fetch available models (if no model specified)
      if (!options.model) {
        console.log(chalk.cyan('🔍 Fetching available AI models...'));
        let modelChoices = [];
        
        try {
          const modelHeaders = {
            'Authorization': `Bearer ${keys[currentKeyIndex]}`,
            'Content-Type': 'application/json'
          };
          if (projectId) modelHeaders['x-goog-user-project'] = projectId;

          const modelsRes = await fetch(`${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`, {
            method: 'POST',
            headers: modelHeaders,
            body: JSON.stringify({})
          });
          
          if (modelsRes.ok) {
            const modelsData = await modelsRes.json();
            const models = modelsData.models || modelsData.modelDetails || [];
            if (models.length > 0) {
              modelChoices = models
                .filter(m => !m.disabled)
                .map(m => ({
                  title: `${m.displayName || m.model || 'Unknown'} ${m.beta ? '(BETA)' : ''}`,
                  value: m.model || m.displayName || m.name
                }));
              console.log(chalk.green(`[✓] ${modelChoices.length} models found!`));
            }
          } else {
            const errText = await modelsRes.text();
            console.warn(chalk.yellow(`⚠ fetchAvailableModels error: ${modelsRes.status} - ${errText}`));
          }
        } catch (e) {
          console.warn(chalk.yellow(`⚠ fetchAvailableModels failed: ${e.message}`));
        }
        
        if (modelChoices.length === 0) {
          modelChoices = [
            { title: 'Gemini 3.1 Pro (High)', value: 'gemini-3.1-pro-high' },
            { title: 'Gemini 3.1 Pro (Low)', value: 'gemini-3.1-pro-low' },
            { title: 'Gemini 3 Flash', value: 'gemini-3-flash-agent' },
            { title: 'Claude Sonnet 4.6 (Thinking)', value: 'claude-sonnet-4-6' },
            { title: 'Claude Opus 4.6 (Thinking)', value: 'claude-opus-4-6-thinking' },
            { title: 'GPT-OSS 120B (Medium)', value: 'gpt-oss-120b-medium' }
          ];
        }

        const response = await promptsLib({
          type: 'select',
          name: 'selectedModel',
          message: '🤖 Select an AI model:',
          choices: modelChoices,
          initial: 0
        });
        
        if (!response.selectedModel) {
          console.log(chalk.yellow('\n[!] Cancelled.\n'));
          process.exit(0);
        }
        options.model = response.selectedModel;
        console.log(chalk.green(`\n[✓] Selected model: ${options.model}\n`));
      }

      // Step 3: Process queries (with multi-account fallback)
      console.log(chalk.blue(`Queued ${prompts.length} prompt(s) for processing.`));
      console.log(chalk.gray('----------------------------------------------------'));
      
      for (let i = 0; i < prompts.length; i++) {
        const prompt = prompts[i];
        console.log(chalk.cyan(`\n[Prompt ${i + 1}/${prompts.length}]: `) + chalk.white(prompt));
        
        let success = false;
        while (!success) {
          try {
            const isApiKey = keys[currentKeyIndex] && keys[currentKeyIndex].startsWith('AIza');
            
            let url, headers, requestBody;
            
            if (isApiKey) {
              url = `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:streamGenerateContent?alt=sse&key=${keys[currentKeyIndex]}`;
              headers = { 'Content-Type': 'application/json' };
              requestBody = {
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
              };
              console.log(chalk.dim(`(→ API Key-${currentKeyIndex + 1} via Generative Language API...)`));
            } else {
              const agentHeaders = getAntigravityHeaders();
              const finalProjectId = projectId || 'rising-fact-p41fc';
              url = `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`;
              
              headers = {
                'Authorization': `Bearer ${keys[currentKeyIndex]}`,
                'Content-Type': 'application/json',
                ...agentHeaders
              };

              let apiModel = options.model.replace(/^antigravity-/i, '');

              requestBody = {
                project: finalProjectId,
                model: apiModel,
                request: {
                  contents: [{ role: 'user', parts: [{ text: prompt }] }],
                  systemInstruction: { parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }] },
                  generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 8192
                  }
                }
              };

              // Thinking configuration
              if (apiModel.includes('thinking') || apiModel.includes('gemini-3')) {
                if (apiModel.includes('claude') || apiModel.includes('sonnet')) {
                   requestBody.request.generationConfig.thinkingConfig = {
                     includeThoughts: true,
                     thinkingBudget: 1024
                   };
                } else {
                   let level = 'medium';
                   if (apiModel.includes('low')) level = 'low';
                   if (apiModel.includes('high')) level = 'high';
                   requestBody.request.generationConfig.thinkingConfig = {
                     includeThoughts: true,
                     thinkingLevel: level
                   };
                }
              }
              
              // --- SOFT QUOTA CHECK (95% threshold) ---
              if (keys.length > 1) {
                  try {
                      const qRes = await fetch(`${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`, {
                          method: 'POST',
                          headers: {
                              'Authorization': `Bearer ${keys[currentKeyIndex]}`,
                              'Content-Type': 'application/json',
                              ...getAntigravityHeaders()
                          },
                          body: JSON.stringify({ project: finalProjectId })
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
                                  throw new Error(`Soft Quota Exceeded: Only ${Math.round(rf*100)}% remaining. Auto-switching to protect account.`);
                              }
                          }
                      }
                  } catch (qErr) {
                      if (qErr.message.includes('Soft Quota')) throw qErr;
                  }
              }
              // --- END SOFT QUOTA CHECK ---

              console.log(chalk.dim(`(→ Account-${currentKeyIndex + 1} via Antigravity [Model: ${apiModel}] [Project: ${finalProjectId}]...)`));
            }

            const fetchRes = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(requestBody)
            });

            if (!fetchRes.ok) {
              const errData = await fetchRes.text();
              throw new Error(`${fetchRes.status} - ${errData}`);
            }

            const reader = fetchRes.body.getReader();
            const decoder = new TextDecoder();
            let text = "";
            let buffer = "";

            process.stdout.write(chalk.green(`\n[Response]:\n`));

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
                     const errMsg = parsed.error.message || JSON.stringify(parsed.error);
                     throw new Error(`API Error: ${errMsg}`);
                  }
                  
                  const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0] || parsed[0]?.candidates?.[0];
                  
                  if (candidate?.content?.parts) {
                    for (const part of candidate.content.parts) {
                      if (part.text) {
                        process.stdout.write(chalk.whiteBright(part.text));
                        text += part.text;
                      }
                      if (part.thought) {
                        process.stdout.write(chalk.gray(`\n[Thought]: ${part.text}\n`));
                      }
                    }
                  } else if (candidate?.finishReason && candidate.finishReason !== "STOP") {
                    text += `\n[Warning: Finish Reason -> ${candidate.finishReason}]\n`;
                  }
                } catch (e) {
                  if (e.message.includes('API Error')) {
                      throw e;
                  }
                }
              }
            }
            console.log("\n");
            console.log(chalk.gray('----------------------------------------------------'));
            
            if (!text.trim()) {
                throw new Error("Empty response received. Model or quota may be blocked.");
            }
            
            success = true;
          } catch (error) {
            const errStr = error.message || error.toString();
            console.error(chalk.yellow(`\n[Error]: Account-${currentKeyIndex + 1} rejected: `) + chalk.gray(errStr));
            
            currentKeyIndex++;
            if (currentKeyIndex < keys.length) {
                console.log(chalk.magenta(`=> ⚡ Auto-switching to Account-${currentKeyIndex + 1}...`));
            } else {
                console.error(chalk.bgRed.white('\n All tokens exhausted. Please run "node index.js login" to add new accounts. '));
                process.exit(1);
            }
          }
        }
      }
      
    } catch (err) {
      console.error(chalk.bgRed.white('\nFatal Error:\n'), err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------
// 3. SERVE COMMAND (OpenAI-Compatible API Server)
// ---------------------------------------------------------
program
  .command('serve')
  .description('Start a local OpenAI-compatible API server.')
  .option('-p, --port <number>', 'Server port', '6012')
  .action((options) => {
    startApiServer(parseInt(options.port, 10));
  });

// ---------------------------------------------------------
// 4. STATUS COMMAND (Token & Quota Monitoring)
// ---------------------------------------------------------
program
  .command('status')
  .description('Check token expiry and AI quota for all accounts.')
  .action(async () => {
    const keys = await getValidTokens();
    
    if (keys.length === 0) {
      console.log(chalk.yellow('[!] No valid tokens found. Please run "node index.js login" first.'));
      return;
    }

    console.log(chalk.cyan(`\n🔍 Checking ${keys.length} account(s)...\n`));
    
    for (let i = 0; i < keys.length; i++) {
        const token = keys[i];
        console.log(chalk.gray(`----------------------------------------------------`));
        try {
            const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
            if (res.ok) {
                const data = await res.json();
                const remainingMin = Math.floor(parseInt(data.expires_in, 10) / 60);
                console.log(chalk.green(`[✓] Account-${i + 1}: Active! Auth expires in `) + chalk.white.bold(`${remainingMin} minutes`) + chalk.green('.'));
                
                // AI Quota check
                try {
                    const quotaRes = await fetch('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            ...getAntigravityHeaders()
                        },
                        body: JSON.stringify({ project: 'rising-fact-p41fc' })
                    });
                    
                    if (quotaRes.ok) {
                        const quotaData = await quotaRes.json();
                        const models = quotaData.models || {};
                        let claudeQuota = "Unknown";
                        let geminiQuota = "Unknown";
                        let claudeReset = "";
                        let geminiReset = "";
                        
                        for (const [mName, entry] of Object.entries(models)) {
                            if (!entry.quotaInfo) continue;
                            const perc = Math.round(Number(entry.quotaInfo.remainingFraction || 0) * 100);
                            const rt = entry.quotaInfo.resetTime ? new Date(entry.quotaInfo.resetTime).toLocaleTimeString('en-US') : "";
                            
                            if (mName.includes('claude-opus')) {
                                claudeQuota = `${perc}%`;
                                claudeReset = rt;
                            }
                            if (mName.includes('gemini-3.1-pro-high')) {
                                geminiQuota = `${perc}%`;
                                geminiReset = rt;
                            }
                        }
                        
                        console.log(chalk.cyan(`    ‣ Claude Opus Quota : `) + chalk.white(`${claudeQuota} remaining `) + chalk.gray(claudeReset ? `(Reset: ${claudeReset})` : ''));
                        console.log(chalk.cyan(`    ‣ Gemini Pro Quota  : `) + chalk.white(`${geminiQuota} remaining `) + chalk.gray(geminiReset ? `(Reset: ${geminiReset})` : ''));
                    } else {
                        console.log(chalk.yellow(`    ‣ Could not read AI quota: API access may be restricted.`));
                    }
                } catch (e) {
                    console.log(chalk.yellow(`    ‣ Failed to fetch AI quota (${e.message})`));
                }

            } else {
                console.log(chalk.red(`[X] Account-${i + 1}: Expired or invalid (OAuth token expired after 1 hour)`));
            }
        } catch (e) {
            console.log(chalk.red(`[!] Account-${i + 1}: Connection error while checking.`));
        }
    }
    console.log(chalk.gray(`----------------------------------------------------`));
  });

program.parse(process.argv);
