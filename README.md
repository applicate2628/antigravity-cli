# 🔓 Antigravity CLI

**Use Claude Opus 4.6, Gemini 3.1 Pro and other premium AI models outside of Antigravity IDE — from your terminal, Cursor, VSCode, or any OpenAI-compatible tool.**

![Antigravity CLI Demo](Recording%202026-03-25%20224251.gif)

Antigravity IDE locks its AI features inside its own editor window. This CLI breaks that limitation by exposing the same models as a local OpenAI-compatible API server, so you can use them **anywhere**.

> **What this does:** Your Google One AI Premium subscription gives you access to Claude Opus, Gemini Pro, etc. through Antigravity IDE. This tool lets you use those same models from any tool — not just the Antigravity editor.

### 🚀 Integration with Developer Tools

This CLI is designed to act as a bridge for your favorite AI-powered development tools. Since it mimics the OpenAI and Anthropic API formats, you can use it to bypass individual account limits by pooling multiple accounts.

#### 🤖 Using with Claude Code (Anthropic CLI)
You can use this with the official `@anthropic-ai/claude-code` by pointing the base URL to your local server.

**Linux / macOS** — export env vars inline and run `claude`:
```bash
# Note: no /v1 suffix — Claude Code appends /v1/messages itself.
# Use AUTH_TOKEN (not API_KEY) so Claude Code treats the value as an
# already-authorized bearer token — no approval prompt, no "Auth conflict" warning.
export ANTHROPIC_BASE_URL="http://localhost:6012"
export ANTHROPIC_AUTH_TOKEN="sk-anything"

# Start Claude Code
claude
```

**Windows — one-click wrapper `claude-ag.cmd`.** Save this anywhere on your `PATH` (e.g. `%USERPROFILE%\.local\bin\`). It wires every Claude Code session to the local proxy and forwards any flags you pass (`--resume`, `--continue`, slash-commands…) through `%*`:

```cmd
@echo off
REM Wrapper: launches Claude Code against the local antigravity-cli proxy on :6012.
REM Default model: claude-opus-4-6-thinking. Override per-run with AG_MODEL.
REM
REM Supported AG_MODEL values (must be one of these — the proxy rejects unknown names
REM and the soft-quota / fallback logic only recognizes this exact set):
REM   claude-opus-4-6-thinking   Claude Opus 4.6 with chain-of-thought (default)
REM   claude-sonnet-4-6          Claude Sonnet 4.6
REM   gemini-3.1-pro-high        Gemini 3.1 Pro (high quality)
REM   gemini-3.1-pro-low         Gemini 3.1 Pro (low latency)
REM   gemini-3-flash-agent       Gemini 3 Flash (fastest)
if not defined AG_MODEL set "AG_MODEL=claude-opus-4-6-thinking"
set "ANTHROPIC_BASE_URL=http://localhost:6012"
set "ANTHROPIC_AUTH_TOKEN=sk-anything"
set "ANTHROPIC_MODEL=%AG_MODEL%"
claude %*
```

Now `claude-ag` (or `claude-ag --resume`, `claude-ag -c`, etc.) opens a Claude Code session already pointed at the proxy — no manual `set` / `export` ever again.

> **`AG_MODEL` accepts exactly five values** — they match the proxy's `BACKEND_MODELS` set in [`api-server.js`](api-server.js) and are also listed in the **Supported Models** table further down: `claude-opus-4-6-thinking`, `claude-sonnet-4-6`, `gemini-3.1-pro-high`, `gemini-3.1-pro-low`, `gemini-3-flash-agent`. Anything else gets normalized by `resolveModel()` (e.g. `opus` → `claude-opus-4-6-thinking`), but the explicit names are the safest choice.

**Per-model shortcuts.** Drop thin variants next to the main wrapper. Each one just presets `AG_MODEL` and delegates back to `claude-ag.cmd` via `call "%~dp0claude-ag.cmd"` (the `%~dp0` prefix is critical — it pins the call to the *same directory* as the variant, so `PATH` ordering can't pick up a different `claude-ag.cmd` by accident):

```cmd
@echo off
REM claude-ag-gemini.cmd
set "AG_MODEL=gemini-3.1-pro-high"
call "%~dp0claude-ag.cmd" %*
```

```cmd
@echo off
REM claude-ag-sonnet.cmd
set "AG_MODEL=claude-sonnet-4-6"
call "%~dp0claude-ag.cmd" %*
```

```cmd
@echo off
REM claude-ag-flash.cmd
set "AG_MODEL=gemini-3-flash-agent"
call "%~dp0claude-ag.cmd" %*
```

Same template works for `claude-ag-low.cmd` (`gemini-3.1-pro-low`) or any other backend model you add later — every variant is literally two `set` lines plus one `call`.

Inside Claude Code, `/model <name>` accepts **any** of the supported backend models
(including `gemini-3.1-pro-high`, `gemini-3.1-pro-low`, `gemini-3-flash-agent`) — the
server implements both `/v1/models` and `/v1/messages/count_tokens`, which Claude Code
uses to validate the selected model on session start. `ANTHROPIC_MODEL` in the wrapper
only pre-selects the **starting** model; you can still switch mid-session with `/model`.

#### 🏗️ Using with Aider
Aider is a popular command-line chat tool. Use it with Antigravity CLI like this:
```bash
aider --openai-api-base http://localhost:6012/v1 --openai-api-key sk-anything --model openai/claude-opus-4-6-thinking
```

#### ✍️ Using with Cursor / VSCode (Continue)
In your IDE settings, add a "Manual" or "OpenAI-Compatible" model:
- **Model Name:** `claude-opus-4-6-thinking`
- **Base URL:** `http://localhost:6012/v1`
- **API Key:** `sk-anything`

---

## 🎯 Why Use This?


| Without this tool | With this tool |
|---|---|
| Claude Opus only works inside Antigravity IDE | Claude Opus works in **Cursor, VSCode, terminal, scripts, APIs** |
| One account at a time | **Unlimited accounts** with automatic rotation |
| No way to check remaining quota | **Real-time quota monitoring** per account |
| Account gets throttled at 100% usage | **Auto-switches** at 95% to protect your accounts |
| Token expires after 1 hour, manual re-login | **Auto-refresh** tokens, never expires |
| Claude Opus quota burned → stuck | **Auto model-fallback** to Gemini 3.1 Pro when all accounts exhaust Claude |

---

## ✨ Features

- 🌐 **OpenAI- and Anthropic-Compatible API** — serves `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens`, and `/v1/models` on `localhost:6012`
- 🤖 **Claude Code CLI ready** — `/model` works with **any** supported backend model (Claude *or* Gemini), not just `claude-*` — the server implements the `count_tokens` probe Claude Code uses to validate models on startup
- 🛠️ **Tool-calling translation** — Anthropic `tool_use` blocks are rewritten to Google Gemini `functionCall` (schemas are normalized — `type` uppercased, unsupported JSON-Schema keys stripped) and responses are translated back, so Claude Code, Aider and other tool-using clients work without custom glue
- 🔄 **Multi-Account Rotation** — Add multiple Google accounts, auto-switches when one is rate-limited (soft-quota check activates when `keys.length > 1`)
- 🛡️ **Soft Quota Protection** — Stops using an account once its remaining fraction drops to ≤ 5% (≈ 95% used), preventing Google throttling
- 🎯 **Auto Model Fallback** — When both accounts exhaust a Claude model within a single request, the server transparently retries with `gemini-3.1-pro-high` on all accounts
- 🔐 **Auto Token Refresh** — Login once, tokens refresh automatically forever (< 5 min before expiry)
- 📊 **Quota Dashboard** — See remaining AI credits and reset times per account
- ⚡ **SSE Streaming** — Real-time response streaming for all three protocols

---

## 📦 Installation

```bash
git clone https://github.com/krmslmz/antigravity-cli.git
cd antigravity-cli
npm install
```

**Requirements:**

- **Node.js v18+**
- An **installed and signed-in Antigravity IDE**. Two things depend on it:
  1. Its `product.json` is read on every `serve` start so the User-Agent matches the Antigravity version Google expects — outdated versions are rejected by the backend.
  2. For **Workspace** accounts, its `settings.json` is the only source for the `geminicodeassist.project` value that becomes the account's `project_id` (see Step 1 below).
- A Google account in one of two flavours — the login flow behaves differently for each:
  - **Personal Google One AI Premium** — `project_id` is auto-resolved during `node index.js login` from Google's `loadCodeAssist` endpoint (`cloudaicompanionProject` field in the response). Nothing else to configure.
  - **Antigravity-enabled Google Workspace** — Workspace OAuth tokens do **not** return `cloudaicompanionProject`, so the `project_id` has to come from the installed Antigravity IDE's `settings.json` (`geminicodeassist.project`), which is populated the first time you sign in to the IDE itself. Without a signed-in IDE, `login` falls back to asking you to paste the project ID manually.

---

## 🔐 Step 1: Login with Google Accounts

```bash
node index.js login
```

Your browser opens a Google sign-in page. Sign in with your **Google One AI Premium** (personal) or **Antigravity-enabled Google Workspace** account.

After the OAuth redirect, the CLI resolves the account's `project_id` through a three-step fallback chain (implemented in `resolveAndOnboardProject()` in [`index.js`](index.js) plus `getAntigravityProjectFromSettings()` in [`auth.js`](auth.js)):

1. **Google-managed project** — calls `loadCodeAssist` on the Google Cloud Code endpoint and reads `cloudaicompanionProject` from the response. This is the normal path for **personal** Google One AI Premium accounts, and nothing else is needed.
2. **Antigravity IDE settings.json** — reads `geminicodeassist.project` from the installed IDE's user settings file:
   - Windows: `%APPDATA%\Antigravity\User\settings.json`
   - macOS: `~/Library/Application Support/Antigravity/User/settings.json`

   This is the **only automatic path for Workspace accounts**, because their OAuth token does not return `cloudaicompanionProject`. If you have a Workspace account but do not have Antigravity IDE installed (or never signed in to it), this step finds nothing and the CLI falls through to step 3.
3. **Manual input** — the CLI interactively asks you to paste the project ID. You can leave it empty to skip, but inference will fail until you add a `project_id` to `keys.json` manually.

The resolved `project_id` is persisted **per-account** in `keys.json` and reused on every subsequent request — no re-query to Google, and different accounts can hold different projects. After login, `node index.js status` shows the resolved project next to each account as `[project: ...]`.

**Adding multiple accounts (recommended):**

Run `login` multiple times to add more accounts. The system stores all accounts and rotates between them automatically:

```bash
node index.js login   # Account 1
node index.js login   # Account 2
node index.js login   # Account 3 ... up to as many as you want
```

> 💡 More accounts = higher combined quota. When Account 1 reaches 95% usage, it automatically switches to Account 2, and so on.

---

## 🌐 Step 2: Start the API Server

```bash
node index.js serve
```

```
🚀 Antigravity API Server running on port 6012!

Endpoints:
  OpenAI:     http://localhost:6012/v1/chat/completions
  Anthropic:  http://localhost:6012/v1/messages
  Models:     http://localhost:6012/v1/models

Compatible with Cursor, VSCode, Claude Code, Aider, and any OpenAI/Anthropic client.
Press Ctrl+C to stop.
```

That's it. You now have a local OpenAI- and Anthropic-compatible API running.

**Windows — one-click launcher:** the repo ships `antigravity-cli-serve.cmd` in the project root. Double-click it (or pin it to Start) and leave the window open while you work.

```cmd
@echo off
REM Start the antigravity-cli API server. Keep this window open while using claude-ag / Cursor / etc.
cd /d "%~dp0"
title Antigravity CLI Server :6012
node index.js serve
pause
```

Two details worth knowing: `cd /d "%~dp0"` pins the working directory to the repo root (where `keys.json`, `config.json` and `node_modules` live) no matter where the `.cmd` was launched from, and `pause` on the last line keeps the window open if `node index.js serve` crashes at startup so you actually see the error instead of a black flash.

Pair it with the `claude-ag.cmd` wrapper from **Step 3 → Using with Claude Code** for a two-double-click flow: one window keeps the server running, the other launches Claude Code pointed at it.

---

## 🔌 Step 3: Connect Your Tools

### Cursor / VSCode / Any OpenAI-Compatible Tool

| Setting | Value |
|---------|-------|
| **Base URL** | `http://localhost:6012/v1` |
| **API Key** | `sk-anything` (any value, not validated) |
| **Model** | `claude-opus-4-6-thinking` |

### Claude Code CLI

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-anything",
    "ANTHROPIC_BASE_URL": "http://localhost:6012"
  }
}
```

> Set only **one** of `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`. If both are set,
> Claude Code prints an `Auth conflict` warning at startup. `ANTHROPIC_BASE_URL` must
> **not** include `/v1` — Claude Code appends `/v1/messages` itself.

### cURL Examples

**Streaming (real-time response):**
```bash
curl -X POST http://localhost:6012/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-6-thinking",
    "messages": [{"role": "user", "content": "Write a haiku about coding"}],
    "stream": true
  }'
```

**Non-streaming (full response):**
```bash
curl -X POST http://localhost:6012/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-6-thinking",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": false
  }'
```

### Python Example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:6012/v1",
    api_key="sk-anything"
)

response = client.chat.completions.create(
    model="claude-opus-4-6-thinking",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

---

## 📊 Step 4: Monitor Your Quota

```bash
node index.js status
```

```
🔍 Checking 3 account(s)...

----------------------------------------------------
[✓] Account-1: Active! Auth expires in 45 minutes. [project: project-alpha-1a2b3c]
    ‣ Claude Opus Quota : 60% remaining (Reset: 02:23 AM)
    ‣ Gemini Pro Quota  : 80% remaining (Reset: 01:22 AM)
----------------------------------------------------
[✓] Account-2: Active! Auth expires in 38 minutes. [project: project-beta-4d5e6f]
    ‣ Claude Opus Quota : 100% remaining (Reset: 03:15 AM)
    ‣ Gemini Pro Quota  : 100% remaining (Reset: 02:45 AM)
----------------------------------------------------
[✓] Account-3: Active! Auth expires in 52 minutes. [project: project-gamma-7g8h9i]
    ‣ Claude Opus Quota : 40% remaining (Reset: 04:00 AM)
    ‣ Gemini Pro Quota  : 90% remaining (Reset: 03:30 AM)
----------------------------------------------------
```

---

## 💬 Bonus: Ask Directly from Terminal

Don't need an API? Ask questions directly:

```bash
# Interactive model selection
node index.js ask "Explain quantum computing in simple terms"

# Specify a model
node index.js ask -m gemini-3.1-pro-high "Write a Python web scraper"

# Batch questions from file
node index.js ask -p questions.json
```

---

## 📋 All Commands

| Command | Description |
|---------|-------------|
| `node index.js setup` | (Optional) Configure your own Google OAuth `CLIENT_ID` / `CLIENT_SECRET` in `config.json` — default embedded values work for most users |
| `node index.js login` | Add a Google account (run multiple times for multi-account) |
| `node index.js serve` | Start the local OpenAI- & Anthropic-compatible API server (port 6012) |
| `node index.js serve -p 8080` | Start on a custom port |
| `node index.js status` | Check token expiry and AI quota per account |
| `node index.js ask "..."` | Ask a question directly from terminal |
| `node index.js ask -m MODEL "..."` | Ask with a specific model |

---

## ⚙️ Supported Models

| Model | Type |
|-------|------|
| `claude-opus-4-6-thinking` | Claude Opus 4.6 with chain-of-thought |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro (high quality) |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro (low latency) |
| `gemini-3-flash-agent` | Gemini 3 Flash (fastest) |

---

## 🛡️ How Auto-Rotation Works

```
Request comes in
    │
    ▼
Check Account 1 quota ──── >95% used? ──── Skip, try next
    │                                          │
    │ <5% used                                 ▼
    │                              Check Account 2 quota ──── >95%? ──── Skip
    ▼                                          │
    │ OK                                       │ OK
    ▼                                          ▼
Send request                               Send request
    │                                          │
    ▼                                          ▼
Return response                            Return response
```

- Checks remaining credits **before** each request (only when `keys.length > 1`)
- If `remainingFraction ≤ 0.05` (≈ 95% used) → skips that account entirely
- On 429 or any backend error → rotates to the next account and retries (up to `keys.length` attempts per request)
- `currentKeyIndex` is persistent across requests, so subsequent requests start from the last-used account instead of wasting a round-trip on a known-bad one
- **Claude-only model fallback:** if the request was for `claude-opus-*` or `claude-sonnet-*` and every account rejected it, the server transparently switches `currentModel` to `gemini-3.1-pro-high` and retries across all accounts a second time
- If the second (Gemini) pass also fails → returns `{ "error": { "message": "All tokens exhausted." } }`

---

## 📁 Project Structure

```
antigravity-cli/
├── index.js           # CLI: login, ask, serve, status commands
├── api-server.js      # OpenAI-compatible Express API server
├── auth.js            # Token management & auto-refresh
├── keys.json          # 🔒 Your tokens (auto-generated, gitignored)
├── package.json       # Dependencies
└── prompts.json       # Example batch questions
```

---

## ⚠️ Important

- **`keys.json` is gitignored** — it contains your personal Google tokens, never share it
- Requires an active **Google One AI Premium** subscription
- The API runs on **localhost only** — not exposed to the internet
- This project is for **personal/educational use**

---

## 📄 License

MIT

---

<p align="center">
  <b>Antigravity CLI</b> — Use Claude & Gemini anywhere, not just inside an IDE. 🧠⚡
</p>
