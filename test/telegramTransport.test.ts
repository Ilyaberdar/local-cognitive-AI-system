import assert from "node:assert/strict";
import test from "node:test";
import { CognitiveEngine } from "../src/core/CognitiveEngine";
import { ResponseFormatter } from "../src/core/ResponseFormatter";
import { ModelCatalogService } from "../src/llm/ModelCatalogService";
import { LocalModelManagerRegistry } from "../src/llm/LocalModelManager";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { TelegramBotTransport } from "../src/transports/telegram/TelegramBotTransport";
import { ProviderDescriptor } from "../src/types";
import { Logger } from "../src/utils/Logger";

type TelegramCall = {
  method: string;
  body: Record<string, unknown>;
};

interface TestableTelegramBotTransport {
  processUpdate(update: unknown): Promise<void>;
  callTelegram(method: string, body: Record<string, unknown>): Promise<{ ok: boolean }>;
}

const createTransport = (ownerUserIds: string[], currentRuntime?: ConstructorParameters<typeof TelegramBotTransport>[8]) => {
  const processRequests: unknown[] = [];
  const telegramCalls: TelegramCall[] = [];
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  const transport = new TelegramBotTransport(
    { token: "test-token", ownerUserIds, pollTimeoutSec: 1 },
    {
      process: async (request: unknown) => {
        processRequests.push(request);
        return {} as never;
      }
    } as unknown as CognitiveEngine,
    {
      formatForChat: () => "owner response"
    } as unknown as ResponseFormatter,
    {} as SessionSettingsStore,
    {} as ModelCatalogService,
    {} as LocalModelManagerRegistry,
    [] as ProviderDescriptor[],
    {
      warn: (message: string, meta?: Record<string, unknown>) => warnings.push({ message, meta })
    } as unknown as Logger,
    currentRuntime
  ) as unknown as TestableTelegramBotTransport;

  transport.callTelegram = async (method, body) => {
    telegramCalls.push({ method, body });
    return { ok: true };
  };

  return { transport, processRequests, telegramCalls, warnings };
};

test("Telegram uses the current runtime after the app's default model changes", async () => {
  let model = "previous model";
  const observed: string[] = [];
  const currentRuntime = () => ({
    engine: { process: async () => { observed.push(model); return {} as never; } } as unknown as CognitiveEngine,
    formatter: { formatForChat: () => model } as unknown as ResponseFormatter,
    sessionSettingsStore: {} as SessionSettingsStore,
    modelCatalog: {} as ModelCatalogService,
    localModelManager: {} as LocalModelManagerRegistry,
    providerDescriptors: []
  });
  const { transport, telegramCalls } = createTransport(["42"], currentRuntime);
  const update = { update_id: 1, message: { text: "Hello", chat: { id: 100 }, from: { id: 42 } } };
  await transport.processUpdate(update);
  model = "new local model";
  await transport.processUpdate({ ...update, update_id: 2 });
  assert.deepEqual(observed, ["previous model", "new local model"]);
  assert.deepEqual(telegramCalls.map(call => call.body.text), observed);
});

test("Telegram ignores commands from a user outside the owner allowlist", async () => {
  const { transport, processRequests, telegramCalls, warnings } = createTransport(["42"]);

  await transport.processUpdate({
    update_id: 1,
    message: {
      text: "/models",
      chat: { id: 100 },
      from: { id: 7 }
    }
  });

  assert.equal(processRequests.length, 0);
  assert.equal(telegramCalls.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "Ignored Telegram update from a non-owner");
});

test("Telegram processes a message from a configured owner", async () => {
  const { transport, processRequests, telegramCalls, warnings } = createTransport(["42"]);

  await transport.processUpdate({
    update_id: 1,
    message: {
      text: "Hello from the owner",
      chat: { id: 100 },
      from: { id: 42 }
    }
  });

  assert.equal(warnings.length, 0);
  assert.deepEqual(processRequests, [
    {
      input: "Hello from the owner",
      actor: {
        sessionId: "100",
        userId: "42",
        channel: "telegram"
      }
    }
  ]);
  assert.deepEqual(telegramCalls, [
    {
      method: "sendMessage",
      body: {
        chat_id: 100,
        text: "owner response"
      }
    }
  ]);
});
