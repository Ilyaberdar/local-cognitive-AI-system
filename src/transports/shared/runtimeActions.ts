import { randomUUID } from "crypto";
import { RuntimeManager } from "../../app/RuntimeManager";
import { SessionIndexStore } from "../../session/SessionIndexStore";
import { Channel, Mode, ProcessProgressEvent, ProcessResult } from "../../types";

export interface ProcessRuntimeInput {
  input: string;
  sessionId?: string;
  sessionTitle?: string;
  userId?: string;
  providerId?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  mode?: Mode;
  signal?: AbortSignal;
  onProgress?: (event: ProcessProgressEvent) => void;
}

export interface ProcessRuntimeResult extends ProcessResult {
  sessionId: string;
}

export const processRuntimeInput = async (
  runtimeManager: RuntimeManager,
  sessionIndexStore: SessionIndexStore,
  payload: ProcessRuntimeInput,
  channel: Channel
): Promise<ProcessRuntimeResult> => {
  const input = payload.input.trim();

  if (!input) {
    throw new Error("Input cannot be empty");
  }

  const runtime = runtimeManager.getRuntime();
  const sessionId = payload.sessionId?.trim() || randomUUID();
  const metadata = {
    ...(payload.metadata ?? {}),
    ...(payload.mode ? { mode: payload.mode } : {})
  };

  await sessionIndexStore.touch(sessionId, {
    title: payload.sessionTitle?.trim() || input.slice(0, 60),
    channel
  });

  const result = await runtime.engine.process({
    input,
    providerId: payload.providerId?.trim() || undefined,
    model: payload.model?.trim() || undefined,
    actor: {
      sessionId,
      userId: payload.userId?.trim() || undefined,
      channel
    },
    metadata,
    signal: payload.signal,
    onProgress: payload.onProgress
  });

  return {
    ...result,
    sessionId
  };
};
