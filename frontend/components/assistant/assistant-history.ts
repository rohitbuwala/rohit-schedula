import { z } from "zod";
import type { AssistantResponse } from "../../lib/assistant-api";

const historySchema = z.object({
  savedAt: z.number(),
  turns: z.array(z.object({ message: z.string().trim().min(1).max(1000), createdAt: z.number().optional(), result: z.unknown().optional() })).max(100),
});
export const CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_HISTORY_TURNS = 100;
export const chatHistoryKey = (patientId: string) => `medrella.chat.v1:patient:${patientId}`;

export function readChatHistory(storage: Pick<Storage, "getItem"> & Partial<Pick<Storage, "removeItem" | "setItem">>, patientId: string, responseSchema: z.ZodType<AssistantResponse>): { message: string; createdAt: number; result?: AssistantResponse }[] {
  try {
    const raw = storage.getItem(chatHistoryKey(patientId));
    if (!raw || raw.length > 2000000) return [];
    const result = historySchema.safeParse(JSON.parse(raw));
    if (!result.success) { storage.removeItem?.(chatHistoryKey(patientId)); return []; }
    const turns = result.data.turns.flatMap((turn) => {
      const createdAt = turn.createdAt ?? result.data.savedAt;
      if (Date.now() - createdAt >= CHAT_RETENTION_MS || createdAt > Date.now()) return [];
      if (turn.result === undefined) return [{ message: turn.message, createdAt }];
      const parsed = responseSchema.safeParse(turn.result);
      return parsed.success ? [{ message: turn.message, createdAt, result: parsed.data }] : [];
    });
    if (!turns.length) storage.removeItem?.(chatHistoryKey(patientId));
    else storage.setItem?.(chatHistoryKey(patientId), JSON.stringify({ savedAt: Date.now(), turns }));
    return turns;
  } catch { return []; }
}

export function saveChatHistory(storage: Pick<Storage, "setItem">, patientId: string, turns: z.infer<typeof historySchema>["turns"]) {
  try {
    const now = Date.now();
    const recent = turns.map((turn) => ({ ...turn, createdAt: turn.createdAt ?? now }))
      .filter((turn) => now - turn.createdAt < CHAT_RETENTION_MS && turn.createdAt <= now).slice(-MAX_HISTORY_TURNS);
    storage.setItem(chatHistoryKey(patientId), JSON.stringify({ savedAt: now, turns: recent }));
  } catch { /* Chat remains usable when storage is full or unavailable. */ }
}
