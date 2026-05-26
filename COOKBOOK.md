# Add Scalekit AgentKit tools to your FastRouter agent

Scalekit AgentKit gives your FastRouter agent access to OAuth-connected services — Gmail, GitHub, Slack, and more — without writing OAuth code per integration. Scalekit handles token storage, tool discovery, and tool execution. Your agent's job is to pick tools, execute them, and loop until done.

FastRouter's OpenAI-compatible API means the integration is one configuration change: point the OpenAI SDK's `baseURL` at FastRouter.

**Sample repository:** [github.com/scalekit-developers/fastrouter-scalekit-demo](https://github.com/scalekit-developers/fastrouter-scalekit-demo)

---

## What Scalekit adds

Without Scalekit, each tool integration (Gmail, GitHub, Slack) needs its own OAuth flow, token storage, and API wrapper. Scalekit AgentKit handles all three:

- **Connected accounts** — Scalekit stores per-user OAuth tokens for each service.
- **Tool discovery** — `listScopedTools` returns tool schemas already in OpenAI function-calling format. Pass them directly to FastRouter.
- **Tool execution** — `executeTool` runs each tool using the user's stored tokens and returns structured results. Your agent never handles raw access tokens.

---

## Prerequisites

- Scalekit account with AgentKit enabled — [app.scalekit.com](https://app.scalekit.com)
- At least one AgentKit connection configured (Gmail, GitHub, or Slack)
- FastRouter API key
- Node.js 20+

---

## Quick start

**Clone and install:**

```sh
git clone https://github.com/scalekit-developers/fastrouter-scalekit-demo
cd fastrouter-scalekit-demo
npm install
```

**Set environment variables:**

```sh
cp .env.example .env
```

Edit `.env`:

```sh
# Scalekit — get from your Scalekit dashboard under API Keys
SCALEKIT_ENVIRONMENT_URL=https://your-env.scalekit.dev
SCALEKIT_CLIENT_ID=your_client_id
SCALEKIT_CLIENT_SECRET=your_client_secret

# Connection name — must match a connection in your Scalekit dashboard
SCALEKIT_CONNECTION_NAME=gmail

# FastRouter
FASTROUTER_API_KEY=sk-v1-...
FASTROUTER_BASE_URL=https://api.fastrouter.ai/api/v1
FASTROUTER_MODEL=openai/gpt-4o-mini
```

**Run:**

```sh
npm start
```

---

## What happens on first run

The agent checks whether the user's account is already connected. If not, it prints an authorization link:

```
Authorization required.
Open this link and complete the flow:

https://your-env.scalekit.dev/magicLink/...

Waiting for callback on http://localhost:3000/callback ...
```

Open the link in your browser and complete the OAuth flow. The agent detects the callback automatically and continues. On subsequent runs, the connected account is already active — no auth step needed.

After authorization:

```
Connected account is now active.
Loaded 17 scoped tools from Scalekit.
Model requested 1 tool call(s).

→ Executing gmail_list_messages
  args: {"maxResults":5,"q":"is:unread"}

Final answer:

Here are your 5 most recent unread emails: ...
```

---

## How it works

### 1. Initialize FastRouter using the OpenAI SDK

FastRouter's API is OpenAI-compatible. Point `baseURL` at FastRouter and pass your FastRouter API key:

```typescript
import OpenAI from 'openai';

const fastRouter = new OpenAI({
  apiKey: process.env.FASTROUTER_API_KEY,
  baseURL: 'https://api.fastrouter.ai/api/v1',
});
```

No other FastRouter-specific setup is required.

### 2. Connect the user's account via Scalekit OAuth

Scalekit handles the OAuth flow. Call `getOrCreateConnectedAccount` to check whether the user's account is already connected. If it isn't, get an auth link and wait for the user to complete the flow.

In B2B environments, Scalekit redirects to your `userVerifyUrl` after OAuth completes and includes an `auth_request_id` parameter. Your app must call `verifyConnectedAccountUser` with that ID to mark the account active.

The sample runs a minimal local HTTP server to handle the redirect automatically:

```typescript
import http from 'http';
import { ScalekitClient } from '@scalekit-sdk/node';
import { ConnectorStatus } from '@scalekit-sdk/node/lib/pkg/grpc/scalekit/v1/connected_accounts/connected_accounts_pb.js';

const scalekit = new ScalekitClient(
  process.env.SCALEKIT_ENVIRONMENT_URL!,
  process.env.SCALEKIT_CLIENT_ID!,
  process.env.SCALEKIT_CLIENT_SECRET!,
);

async function connectUser(connectionName: string, identifier: string) {
  const callbackPort = 3000;
  const userVerifyUrl = `http://localhost:${callbackPort}/callback`;

  const { connectedAccount } = await scalekit.actions.getOrCreateConnectedAccount({
    connectionName,
    identifier,
    userVerifyUrl,
  });

  if (connectedAccount?.status === ConnectorStatus.ACTIVE) return;

  const { link } = await scalekit.actions.getAuthorizationLink({
    connectionName,
    identifier,
    userVerifyUrl,
  });

  console.log(`Open this link to authorize:\n\n${link}\n`);

  // Wait for Scalekit to redirect to localhost:3000/callback?auth_request_id=...
  const authRequestId = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${callbackPort}`);
      const id = url.searchParams.get('auth_request_id');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authorization complete — return to your terminal.</h2>');
      server.close();
      if (id) resolve(id);
      else reject(new Error('Missing auth_request_id'));
    });
    server.listen(callbackPort);
  });

  await scalekit.actions.verifyConnectedAccountUser({ authRequestId, identifier });
}
```

> **Production note:** Replace `localhost:3000/callback` with your server's callback endpoint. Scalekit posts `auth_request_id` there; your handler calls `verifyConnectedAccountUser` to complete activation.

### 3. Discover tools and pass them to FastRouter

`listScopedTools` returns only the tools the connected account has permission to use. Map `input_schema` to `parameters` for FastRouter's function-calling format:

```typescript
async function loadTools(identifier: string, connectionName: string) {
  const { tools } = await scalekit.tools.listScopedTools(identifier, {
    filter: { connectionNames: [connectionName] },
    pageSize: 100,
  });

  return tools
    .map((t) => t.tool?.definition)
    .filter((def): def is NonNullable<typeof def> => Boolean(def?.name))
    .map((def) => ({
      type: 'function' as const,
      function: {
        name: String(def.name),
        description: String(def.description ?? ''),
        parameters: def.input_schema ?? { type: 'object', properties: {} },
      },
    }));
}
```

FastRouter accepts this format directly — no additional transformation needed.

### 4. Run the agentic loop

Call FastRouter with the tool list. Execute each tool call through Scalekit and append the results. Repeat until FastRouter returns a response with no tool calls:

```typescript
async function run(connectionName: string, identifier: string, userPrompt: string) {
  const tools = await loadTools(identifier, connectionName);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: 'Use tools when they help. Do not invent results. Answer concisely.',
    },
    { role: 'user', content: userPrompt },
  ];

  for (let turn = 0; turn < 8; turn++) {
    const response = await fastRouter.chat.completions.create({
      model: process.env.FASTROUTER_MODEL ?? 'openai/gpt-4o-mini',
      messages,
      tools,
      tool_choice: 'auto',
    });

    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      console.log(message.content); // Final answer — done
      return;
    }

    for (const call of message.tool_calls) {
      const result = await scalekit.actions.executeTool({
        toolName: call.function.name,
        identifier,
        connector: connectionName,
        toolInput: JSON.parse(call.function.arguments),
      });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result.data ?? {}),
      });
    }
  }
}
```

---

## Supported connections

Set `SCALEKIT_CONNECTION_NAME` to any connection configured in your Scalekit dashboard:

| Value | What it connects |
|-------|-----------------|
| `gmail` | Gmail read, send, search |
| `github` | Repositories, issues, pull requests |
| `slack` | Channels, messages, users |

To use multiple connections in one agent, pass all connection names to `listScopedTools`:

```typescript
const { tools } = await scalekit.tools.listScopedTools(identifier, {
  filter: { connectionNames: ['gmail', 'github', 'slack'] },
});
```

---

## Change the prompt

Pass a prompt as a CLI argument:

```sh
npm start "Summarize all open pull requests assigned to me on GitHub"
```

---

## Resources

- [Sample repository](https://github.com/scalekit-developers/fastrouter-scalekit-demo)
- [Scalekit AgentKit docs](https://docs.scalekit.com/agentkit)
- [Scalekit dashboard](https://app.scalekit.com)
