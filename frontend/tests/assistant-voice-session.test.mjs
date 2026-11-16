import assert from "node:assert/strict";
import { it } from "node:test";
import { createAssistantVoiceSession, handoffAssistantRecorder, startAssistantVoiceWhenReady } from "../components/assistant/assistant-voice-session.ts";
import { appendSpeechTranscript } from "../components/assistant/assistant-speech.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("waits for microphone cleanup before starting live voice, and respects cancellation", async () => {
  const cleanup = deferred();
  let starts = 0;
  const ready = startAssistantVoiceWhenReady(cleanup.promise, () => true, () => { starts++; return true; });
  assert.equal(starts, 0);
  cleanup.resolve();
  assert.equal(await ready, true);
  assert.equal(starts, 1);
  const cancelled = deferred();
  let current = true;
  const waiting = startAssistantVoiceWhenReady(cancelled.promise, () => current, () => { starts++; return true; });
  current = false; cancelled.resolve();
  assert.equal(await waiting, false);
  assert.equal(starts, 1);
  assert.equal(await startAssistantVoiceWhenReady(null, () => true, () => false), false);
});

it("releases rejected and throwing recorder handoffs but leaves accepted ownership intact", () => {
  let cancelled = 0;
  const recorder = { cancel: () => cancelled++ };
  assert.equal(handoffAssistantRecorder(recorder, () => false), false);
  assert.throws(() => handoffAssistantRecorder(recorder, () => { throw new Error("failed"); }), /failed/);
  assert.equal(cancelled, 2);
  assert.equal(handoffAssistantRecorder(recorder, () => true), true);
  assert.equal(cancelled, 2);
});

it("stops recording, transcribes once, and appends to the currently edited draft", async () => {
  const audio = deferred();
  const events = [];
  let draft = "original";
  let stops = 0;
  const session = createAssistantVoiceSession({
    start: async () => ({ result: audio.promise, stop: () => { stops++; return audio.promise; }, cancel() {} }),
    transcribe: async () => "my appointments",
    onState: (state) => events.push(state),
    onTranscript: (text) => { draft = appendSpeechTranscript(draft, text); },
    onError: () => assert.fail("unexpected error"), onEnd: () => events.push("end"),
  });
  await Promise.resolve();
  draft = "edited draft";
  session.stop(); session.stop();
  audio.resolve(new Blob(["wav"]));
  await session.done;
  assert.equal(stops, 1);
  assert.equal(draft, "edited draft my appointments");
  assert.deepEqual(events, ["starting", "listening", "stopping", "transcribing", "end"]);
});

it("cancels a pending recorder and suppresses uploads and late callbacks", async () => {
  const pending = deferred();
  let cancelled = 0, uploads = 0, ended = 0;
  const session = createAssistantVoiceSession({
    start: () => pending.promise,
    transcribe: async () => { uploads++; return "late"; },
    onState() {}, onTranscript() { assert.fail("late transcript"); }, onError() { assert.fail("late error"); },
    onEnd() { ended++; },
  });
  session.cancel();
  pending.resolve({ result: Promise.resolve(new Blob()), stop: async () => new Blob(), cancel: () => cancelled++ });
  await session.done;
  assert.equal(cancelled, 1); assert.equal(uploads, 0); assert.equal(ended, 0);
});

it("cancels an in-flight transcription and ignores a late response", async () => {
  const response = deferred();
  let signal;
  const session = createAssistantVoiceSession({
    start: async () => ({ result: Promise.resolve(new Blob()), stop: async () => new Blob(), cancel() {} }),
    transcribe: (_, requestSignal) => { signal = requestSignal; return response.promise; },
    onState() {}, onTranscript() { assert.fail("late transcript"); }, onError() { assert.fail("late error"); }, onEnd() { assert.fail("late end"); },
  });
  while (!signal) await Promise.resolve();
  session.cancel();
  assert.equal(signal.aborted, true);
  response.resolve("late");
  await session.done;
});

it("reports recording and provider failures and ends the session", async () => {
  const failure = new Error("failed");
  const errors = [];
  let ended = false;
  const session = createAssistantVoiceSession({ start: async () => { throw failure; }, transcribe: async () => "",
    onState() {}, onTranscript() {}, onError: (error) => errors.push(error), onEnd: () => { ended = true; } });
  await session.done;
  assert.deepEqual(errors, [failure]); assert.equal(ended, true);
});

it("reports a transcription failure without altering the draft", async () => {
  const errors = [];
  let draft = "editable";
  const session = createAssistantVoiceSession({
    start: async () => ({ result: Promise.resolve(new Blob()), stop: async () => new Blob(), cancel() {} }),
    transcribe: async () => { throw new Error("unavailable"); },
    onState() {}, onTranscript: (text) => { draft = appendSpeechTranscript(draft, text); },
    onError: (error) => errors.push(error.message), onEnd() {},
  });
  await session.done;
  assert.equal(draft, "editable");
  assert.deepEqual(errors, ["unavailable"]);
});

it("does not transcribe a recording rejected for absent speech", async () => {
  let uploads = 0;
  const errors = [];
  const session = createAssistantVoiceSession({
    start: async () => ({ result: Promise.reject(new Error("No speech was detected.")), stop: async () => new Blob(), cancel() {} }),
    transcribe: async () => { uploads++; return "unexpected"; },
    onState() {}, onTranscript() { assert.fail("unexpected transcript"); },
    onError: (error) => errors.push(error.message), onEnd() {},
  });
  await session.done;
  assert.equal(uploads, 0);
  assert.deepEqual(errors, ["No speech was detected."]);
});
