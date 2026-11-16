import assert from "node:assert/strict";
import { it } from "node:test";
import { playAssistantAudio } from "../components/assistant/assistant-audio-playback.ts";

it("stops playback and releases the object URL without invoking late callbacks", async (t) => {
  const events = [];
  const players = [];
  t.mock.method(URL, "createObjectURL", () => "blob:test");
  t.mock.method(URL, "revokeObjectURL", (url) => events.push(url));
  const original = globalThis.Audio;
  globalThis.Audio = class { constructor() { players.push(this); } async play() {} pause() { events.push("pause"); } removeAttribute() {} load() {} };
  try {
    const session = playAssistantAudio(new Blob(["audio"]), { onEnd: () => events.push("end"), onError: () => events.push("error") });
    const late = players[0].onended;
    session.stop(); late(); session.stop();
    assert.deepEqual(events, ["pause", "blob:test"]);
  } finally { globalThis.Audio = original; }
});
