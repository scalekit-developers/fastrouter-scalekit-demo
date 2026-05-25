import 'dotenv/config';
import { ScalekitClient } from '@scalekit-sdk/node';
import { ConnectorStatus } from '@scalekit-sdk/node/lib/pkg/grpc/scalekit/v1/connected_accounts/connected_accounts_pb.js';
import OpenAI from 'openai';
import * as readline from 'readline';

const env = {
  SCALEKIT_ENVIRONMENT_URL: mustGetEnv('SCALEKIT_ENVIRONMENT_URL'),
  SCALEKIT_CLIENT_ID: mustGetEnv('SCALEKIT_CLIENT_ID'),
  SCALEKIT_CLIENT_SECRET: mustGetEnv('SCALEKIT_CLIENT_SECRET'),
  SCALEKIT_CONNECTION_NAME: mustGetEnv('SCALEKIT_CONNECTION_NAME'),
  SCALEKIT_IDENTIFIER: process.env.SCALEKIT_IDENTIFIER || 'user_123',
  FASTROUTER_API_KEY: mustGetEnv('FASTROUTER_API_KEY'),
  FASTROUTER_BASE_URL: process.env.FASTROUTER_BASE_URL || 'https://api.fastrouter.ai/api/v1',
  FASTROUTER_MODEL: process.env.FASTROUTER_MODEL || 'openai/gpt-4o',
  USER_PROMPT: process.env.USER_PROMPT || 'Fetch my last 5 unread emails and summarize them.',
};

const prompt = process.argv[2] || env.USER_PROMPT;

const scalekit = new ScalekitClient(
  env.SCALEKIT_ENVIRONMENT_URL,
  env.SCALEKIT_CLIENT_ID,
  env.SCALEKIT_CLIENT_SECRET,
);

const fastRouter = new OpenAI({
  apiKey: env.FASTROUTER_API_KEY,
  baseURL: env.FASTROUTER_BASE_URL,
});

async function main() {
  console.log(`Using connection: ${env.SCALEKIT_CONNECTION_NAME}`);
  console.log(`Using identifier: ${env.SCALEKIT_IDENTIFIER}`);
  console.log(`Using FastRouter model: ${env.FASTROUTER_MODEL}`);
  console.log(`Prompt: ${prompt}\n`);

  await ensureConnectedAccount();

  const tools = await loadScopedTools();
  if (tools.length === 0) {
    throw new Error(`No scoped tools returned for connection ${env.SCALEKIT_CONNECTION_NAME}`);
  }

  console.log(`Loaded ${tools.length} scoped tools from Scalekit.`);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: [
        'You are a helpful assistant.',
        'Use tools when they help answer the user request accurately.',
        'Do not invent tool results.',
        'After receiving tool results, answer clearly and concisely.',
      ].join(' '),
    },
    { role: 'user', content: prompt },
  ];

  const MAX_TURNS = 8;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await fastRouter.chat.completions.create({
      model: env.FASTROUTER_MODEL,
      messages,
      tools,
      tool_choice: 'auto',
    });

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error('FastRouter returned no message');
    }

    messages.push(message);

    if (!message.tool_calls?.length) {
      console.log('\nFinal answer:\n');
      console.log(message.content ?? '(no content)');
      return;
    }

    console.log(`Model requested ${message.tool_calls.length} tool call(s).`);

    for (const toolCall of message.tool_calls) {
      const args = safeParseJson(toolCall.function.arguments);
      console.log(`\n→ Executing ${toolCall.function.name}`);
      console.log(`  args: ${JSON.stringify(args)}`);

      let toolResult: unknown;
      try {
        const result = await scalekit.actions.executeTool({
          toolName: toolCall.function.name,
          identifier: env.SCALEKIT_IDENTIFIER,
          connector: env.SCALEKIT_CONNECTION_NAME,
          toolInput: args,
        });
        toolResult = result.data ?? {};
      } catch (error) {
        toolResult = {
          error: error instanceof Error ? error.message : String(error),
        };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  throw new Error(`Exceeded ${MAX_TURNS} turns without a final answer`);
}

async function ensureConnectedAccount() {
  const { connectedAccount } = await scalekit.actions.getOrCreateConnectedAccount({
    connectionName: env.SCALEKIT_CONNECTION_NAME,
    identifier: env.SCALEKIT_IDENTIFIER,
  });

  if (connectedAccount?.status === ConnectorStatus.ACTIVE) {
    console.log('Connected account is already active.\n');
    return;
  }

  const { link } = await scalekit.actions.getAuthorizationLink({
    connectionName: env.SCALEKIT_CONNECTION_NAME,
    identifier: env.SCALEKIT_IDENTIFIER,
  });

  console.log('Authorization required.');
  console.log(`Open this link and complete the flow:\n\n${link}\n`);
  await waitForEnter('Press Enter after authorization is complete... ');

  const check = await scalekit.actions.getOrCreateConnectedAccount({
    connectionName: env.SCALEKIT_CONNECTION_NAME,
    identifier: env.SCALEKIT_IDENTIFIER,
  });

  if (check.connectedAccount?.status !== ConnectorStatus.ACTIVE) {
    throw new Error(`${env.SCALEKIT_CONNECTION_NAME} is still not active after authorization`);
  }

  console.log('Connected account is now active.\n');
}

async function loadScopedTools(): Promise<OpenAI.ChatCompletionTool[]> {
  const { tools } = await scalekit.tools.listScopedTools(env.SCALEKIT_IDENTIFIER, {
    filter: { connectionNames: [env.SCALEKIT_CONNECTION_NAME] },
    pageSize: 100,
  });

  return tools
    .map((tool) => tool.tool?.definition)
    .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition?.name))
    .map((definition) => ({
      type: 'function' as const,
      function: {
        name: String(definition.name),
        description: String(definition.description ?? ''),
        parameters: (definition.input_schema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      },
    }));
}

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error(`Tool arguments were not valid JSON: ${value}`);
  }
}

async function waitForEnter(promptText: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

main().catch((error) => {
  console.error('\nError:\n');
  console.error(error);
  process.exit(1);
});
