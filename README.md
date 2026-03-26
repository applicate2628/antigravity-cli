# 🔓 Antigravity Unlocked

**Use Claude Opus 4.6, Gemini 3.1 Pro and other premium AI models outside of Antigravity IDE — from your terminal, Cursor, VSCode, or any OpenAI-compatible tool.**

Antigravity IDE locks its AI features inside its own editor window. This CLI breaks that limitation by exposing the same models as a local OpenAI-compatible API server, so you can use them **anywhere**.

> **What this does:** Your Google One AI Premium subscription gives you access to Claude Opus, Gemini Pro, etc. through Antigravity IDE. This tool lets you use those same models from any tool — not just the Antigravity editor.

---

## 🎯 Why Does This Exist?

| Without this tool | With this tool |
|---|---|
| Claude Opus only works inside Antigravity IDE | Claude Opus works in **Cursor, VSCode, terminal, scripts, APIs** |
| One account at a time | **8+ accounts** with automatic rotation |
| No way to check remaining quota | **Real-time quota monitoring** per account |
| Account gets throttled at 100% usage | **Auto-switches** at 95% to protect your accounts |
| Token expires after 1 hour, manual re-login | **Auto-refresh** tokens, never expires |

---

## ✨ Features

- 🌐 **Local OpenAI-Compatible API** — `localhost:6012/v1/chat/completions` endpoint works with any tool
- 🔄 **Multi-Account Rotation** — Add multiple Google accounts, auto-switches when one is rate-limited
- 🛡️ **Soft Quota Protection** — Stops using an account at 95% usage, preventing Google throttling
- 🔐 **Auto Token Refresh** — Login once, tokens refresh automatically forever
- 📊 **Quota Dashboard** — See remaining AI credits and reset times per account
- ⚡ **SSE Streaming** — Real-time response streaming, just like OpenAI

---

## 📦 Installation

```bash
git clone https://github.com/user/antigravity-unlocked.git
cd antigravity-unlocked
npm install
```

**Requirements:** Node.js v18+ and a Google One AI Premium subscription.

---

## 🔐 Step 1: Login with Google Accounts

```bash
node index.js login
```

Your browser will open a Google sign-in page. Sign in with your Google One AI Premium account.

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
🚀 Antigravity Local API Server running on port 6012!
Endpoint: http://localhost:6012/v1/chat/completions
```

That's it. You now have a local OpenAI-compatible API running.

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
    "ANTHROPIC_API_KEY": "sk-anything",
    "ANTHROPIC_BASE_URL": "http://localhost:6012/v1"
  }
}
```

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
🔍 Checking Tokens (3 Accounts)...

----------------------------------------------------
[✓] Token-1: Active! Auth expires in 45 min.
    ‣ Claude Opus Quota : 60% remaining (Reset: 02:23)
    ‣ Gemini Pro Quota  : 80% remaining (Reset: 01:22)
----------------------------------------------------
[✓] Token-2: Active! Auth expires in 38 min.
    ‣ Claude Opus Quota : 100% remaining (Reset: 03:15)
    ‣ Gemini Pro Quota  : 100% remaining (Reset: 02:45)
----------------------------------------------------
[✓] Token-3: Active! Auth expires in 52 min.
    ‣ Claude Opus Quota : 40% remaining (Reset: 04:00)
    ‣ Gemini Pro Quota  : 90% remaining (Reset: 03:30)
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
| `node index.js login` | Add a Google account (run multiple times for multi-account) |
| `node index.js serve` | Start the local OpenAI-compatible API server (port 6012) |
| `node index.js serve --port 8080` | Start on a custom port |
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
Send request                                   │ OK
    │                                          ▼
    ▼                                  Send request
Return response                            │
                                           ▼
                                   Return response
```

- Checks remaining credits **before** each request
- If below 5% remaining → skips that account entirely
- Moves to next account automatically
- If all accounts exhausted → returns error with reset times

---

## 📁 Project Structure

```
antigravity-unlocked/
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
  <b>Antigravity Unlocked</b> — Use Claude & Gemini anywhere, not just inside an IDE. 🧠⚡
</p>
