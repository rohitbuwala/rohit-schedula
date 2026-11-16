import assert from "node:assert/strict";
import { it } from "node:test";
import { chatHistoryKey, readChatHistory as readHistory, saveChatHistory } from "../components/assistant/assistant-history.ts";
import { assistantResponseSchema } from "../lib/assistant-api.ts";
import { CHAT_RETENTION_MS } from "../components/assistant/assistant-history.ts";
const readChatHistory = (storage, patient) => readHistory(storage, patient, assistantResponseSchema);

it("restores chat after reload without sharing messages between patients", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const turns = [{ message: "find my booking", createdAt: Date.now(), result: { tool: "clarify", reply: "Please choose an option.", data: null } }];
  saveChatHistory(storage, "patient-a", turns);
  assert.deepEqual(readChatHistory(storage, "patient-a"), turns);
  assert.deepEqual(readChatHistory(storage, "patient-b"), []);
  saveChatHistory(storage, "patient-a", Array.from({ length: 110 }, () => turns[0]));
  assert.equal(readChatHistory(storage, "patient-a").length, 100);
  storage.setItem(chatHistoryKey("patient-a"), JSON.stringify({ savedAt: Date.now(), turns: [{ ...turns[0], createdAt: Date.now() - CHAT_RETENTION_MS - 1 }] }));
  assert.deepEqual(readChatHistory(storage, "patient-a"), []);
});

it("keeps six-day-old messages but never extends their lifetime when saving new messages", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const old = { message: "old message", createdAt: Date.now() - 6 * 86400000 };
  saveChatHistory(storage, "patient", [old]);
  assert.deepEqual(readChatHistory(storage, "patient"), [old]);
  saveChatHistory(storage, "patient", [{ ...old, createdAt: Date.now() - CHAT_RETENTION_MS }, { message: "new message", createdAt: Date.now() }]);
  assert.deepEqual(readChatHistory(storage, "patient").map((turn) => turn.message), ["new message"]);
  storage.setItem(chatHistoryKey("patient"), JSON.stringify({ savedAt: Date.now() - CHAT_RETENTION_MS - 1, turns: [{ message: "legacy" }] }));
  assert.deepEqual(readChatHistory(storage, "patient"), []);
  assert.equal(storage.getItem(chatHistoryKey("patient")), null);
});

it("ignores corrupt or inaccessible history without breaking chat", () => {
  assert.deepEqual(readChatHistory({ getItem: () => "not JSON" }, "patient"), []);
  assert.deepEqual(readChatHistory({ getItem() { throw new Error("disabled"); } }, "patient"), []);
  assert.doesNotThrow(() => saveChatHistory({ setItem() { throw new Error("full"); } }, "patient", []));
});
