# FastRouter + Scalekit tool-calling sample

A small TypeScript CLI that proves the integration pattern we want:

- **FastRouter** handles the LLM call through its OpenAI-compatible chat completions API.
- **Scalekit AgentKit** handles OAuth, connected accounts, scoped tool discovery, and tool execution.

This sample keeps the use case intentionally small. By default it uses a single AgentKit connection such as `gmail`, lets the model choose from that connection's scoped tools, executes those tools through Scalekit, and feeds the tool results back into FastRouter until the model returns a final answer.

## What this proves

1. A FastRouter model can select tools using the standard OpenAI `tools` format.
2. Scalekit can supply the tool definitions dynamically for one connected user.
3. Scalekit can execute the selected tools without your app handling third-party OAuth tokens.
4. The full loop works in TypeScript with the official `openai` SDK.

## Prerequisites

- Node.js 20+
- A FastRouter API key
- A Scalekit account with at least one AgentKit connection configured
- Permission to authorize a real connected account for the chosen connection

## Setup

Copy the env file and fill in your values.

```bash
cp .env.example .env
```

Important values:

- `SCALEKIT_CONNECTION_NAME`: the exact connection name from Scalekit dashboard
- `SCALEKIT_IDENTIFIER`: the user identifier whose tools should be authorized and executed
- `FASTROUTER_MODEL`: any FastRouter model that supports tool calling

## Install and run

```bash
npm install
npm run start
```

Or pass a custom prompt:

```bash
npm run start -- "Search my inbox for unread GitHub emails and summarize them"
```

If the connected account is not active yet, the script prints an authorization link. Open it, finish the OAuth flow, return to the terminal, and press Enter.

## Recommended first run

Use a Gmail connection first because it gives an easy read-only prompt to validate the loop:

```env
SCALEKIT_CONNECTION_NAME=gmail
USER_PROMPT=Fetch my last 5 unread emails and summarize them.
```

You can also swap the connection name to another AgentKit connector if that connector exposes useful tools for the same user.

## Verify the sample

Run:

```bash
npm run typecheck
npm run start
```

A successful run should show:

- the connection becoming active or an auth link
- scoped tools being loaded from Scalekit
- one or more tool calls chosen by the model
- a final natural-language answer from the model

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | end-to-end FastRouter + Scalekit loop |
| `.env.example` | required environment variables |
| `package.json` | scripts and dependencies |

## Notes

- The sample uses FastRouter's OpenAI-compatible API with the official `openai` package.
- The sample intentionally stays CLI-only so we can validate the core integration before building a larger app or writing a cookbook.
