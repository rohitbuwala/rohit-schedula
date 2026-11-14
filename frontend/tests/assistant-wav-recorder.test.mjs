import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { createEndOfSpeechDetector, encodeAssistantWav, hasAssistantSpeech, MAX_SAMPLES, startAssistantWavRecorder } from "../components/assistant/assistant-wav-recorder.ts";
import { createBargeDetector } from "../components/assistant/assistant-barge-detector.ts";

function voicedFrames(amplitude = 2000) {
  return Int16Array.from({ length: 320 * 10 }, (_, i) => Math.round(amplitude * (Math.floor(i / 320) % 2 ? 1 : 0.45) * Math.sin(2 * Math.PI * 180 * i / 16000)));
}

it("ends after speech and 1.2 seconds of silence, preserving short pauses and chunk boundaries", () => {
  const detect = createEndOfSpeechDetector();
  assert.equal(detect(new Int16Array(32000)), false);
  const speech = voicedFrames();
  for (let i = 0; i < speech.length; i += 127) assert.equal(detect(speech.subarray(i, i + 127)), false);
  assert.equal(detect(new Int16Array(16000)), false);
  assert.equal(detect(speech), false);
  assert.equal(detect(new Int16Array(19199)), false);
  assert.equal(detect(Int16Array.of(0)), true);
  assert.equal(detect(new Int16Array(19200)), false);
});

it("does not end on initial silence, clicks, or broadband noise", () => {
  const detect = createEndOfSpeechDetector();
  assert.equal(detect(new Int16Array(32000)), false);
  assert.equal(detect(Int16Array.of(30000, -30000)), false);
  assert.equal(detect(new Int16Array(19200)), false);
  const steady = Int16Array.from({ length: 3200 }, (_, i) => i % 2 ? -5000 : 5000);
  const background = createEndOfSpeechDetector();
  assert.equal(background(steady), false);
  assert.equal(background(new Int16Array(19200)), false);
});

it("accepts gain-compressed activity while rejecting silence, short bursts and broadband noise", () => {
  assert.equal(hasAssistantSpeech(new Int16Array(3200)), false);
  assert.equal(hasAssistantSpeech(Int16Array.from({ length: 3200 }, (_, i) => Math.round(4000 * Math.sin(2 * Math.PI * 200 * i / 16000)))), true);
  assert.equal(hasAssistantSpeech(Int16Array.from({ length: 3200 }, (_, i) => i % 2 ? -5000 : 5000)), false);
  assert.equal(hasAssistantSpeech(voicedFrames()), true);
  assert.equal(hasAssistantSpeech(voicedFrames().subarray(0, 320 * 4)), false);
});

it("ends quiet or gain-compressed speech and tolerates a low background hum during pauses", () => {
  assert.equal(hasAssistantSpeech(voicedFrames(800)), true);
  const detect = createEndOfSpeechDetector();
  const compressed = Int16Array.from({ length: 6400 }, (_, i) => Math.round(3000 * Math.sin(2 * Math.PI * 180 * i / 16000)));
  assert.equal(detect(compressed), false);
  const hum = Int16Array.from({ length: 19200 }, (_, i) => Math.round(500 * Math.sin(2 * Math.PI * 60 * i / 16000)));
  assert.equal(detect(hum.subarray(0, 16000)), false);
  assert.equal(detect(hum.subarray(16000)), true);
});

it("requires sustained speech-like activity after the settling period", () => {
  const detector = createBargeDetector();
  const frame = Int16Array.from({ length: 320 }, (_, i) => Math.round(5000 * Math.sin(2 * Math.PI * 200 * i / 16000)));
  for (let i = 0; i < 79; i++) assert.equal(detector(frame), false);
  assert.equal(detector(frame), true);
  assert.equal(detector(frame), false);
  const noise = createBargeDetector();
  for (let i = 0; i < 100; i++) assert.equal(noise(new Int16Array(320)), false);
  for (let i = 0; i < 20; i++) assert.equal(noise(frame), false);
  assert.equal(noise(new Int16Array(320)), false);
  for (let i = 0; i < 29; i++) assert.equal(noise(frame), false);
  assert.equal(noise(frame), true);
});

it("does not interrupt on a short burst or activity below the conservative threshold", () => {
  const detector = createBargeDetector();
  const quiet = Int16Array.from({ length: 320 }, (_, i) => Math.round(500 * Math.sin(2 * Math.PI * 200 * i / 16000)));
  const loud = Int16Array.from({ length: 320 }, (_, i) => Math.round(5000 * Math.sin(2 * Math.PI * 200 * i / 16000)));
  for (let i = 0; i < 100; i++) assert.equal(detector(quiet), false);
  for (let i = 0; i < 29; i++) assert.equal(detector(loud), false);
  assert.equal(detector(new Int16Array(320)), false);
});

it("encodes mono 16 kHz PCM WAV with exact sample data", async () => {
  const blob = encodeAssistantWav(Int16Array.from([-32768, 0, 32767]));
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  assert.equal(blob.type, "audio/wav");
  assert.equal(bytes.byteLength, 50);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(view.getUint32(4, true), 42);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual([44, 46, 48].map((offset) => view.getInt16(offset, true)), [-32768, 0, 32767]);
  assert.throws(() => encodeAssistantWav(new Int16Array()));
  assert.throws(() => encodeAssistantWav(new Int16Array(MAX_SAMPLES + 1)));
});

function worklet(rate) {
  let Processor;
  class Base { constructor() { this.port = { messages: [], postMessage(message) { this.messages.push(message); } }; } }
  const code = readFileSync(new URL("../public/assistant-pcm-worklet.js", import.meta.url), "utf8");
  runInNewContext(code, { AudioWorkletProcessor: Base, sampleRate: rate, Int16Array, registerProcessor: (_, p) => { Processor = p; } });
  return new Processor();
}

it("resamples input and stops precisely at 30 seconds", () => {
  const recorder = worklet(48000);
  const chunk = new Float32Array(480).fill(0.5);
  for (let i = 0; i < 3000; i++) recorder.process([[chunk]]);
  const chunks = recorder.port.messages.filter((item) => item.type === "samples");
  assert.equal(chunks.reduce((sum, item) => sum + item.pcm.length, 0), MAX_SAMPLES);
  assert.equal(chunks[0].pcm[0], 16384);
  assert.equal(recorder.port.messages.at(-1).type, "end");
  assert.equal(recorder.process([[chunk]]), false);
});

it("ends once on manual stop and does not emit further audio", () => {
  const recorder = worklet(44100);
  recorder.process([[new Float32Array(441).fill(-1)]]);
  assert.equal(recorder.port.messages[0].pcm.length, 160);
  recorder.port.onmessage({ data: "stop" });
  recorder.port.onmessage({ data: "stop" });
  assert.equal(recorder.port.messages.filter((item) => item.type === "end").length, 1);
  assert.equal(recorder.process([[new Float32Array(441)]]), false);
});

it("releases the microphone on stop and cancellation", async () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedContext = globalThis.AudioContext;
  const savedNode = globalThis.AudioWorkletNode;
  const nodes = [];
  let stops = 0;
  const audioNode = () => ({ connect(other) { return other; }, disconnect() {} });
  class Context {
    state = "running";
    audioWorklet = { addModule: async () => {} };
    destination = {};
    createMediaStreamSource() { return audioNode(); }
    createGain() { return { ...audioNode(), gain: { value: 1 } }; }
    async close() { this.state = "closed"; }
  }
  class Node {
    constructor() { nodes.push(this); this.sent = []; this.port = { postMessage: (message) => this.sent.push(message) }; }
    connect(other) { return other; }
    disconnect() {}
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stops++ }] }) } } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: Context, AudioWorkletNode: Node } });
  globalThis.AudioContext = Context;
  globalThis.AudioWorkletNode = Node;
  try {
    const session = await startAssistantWavRecorder();
    const node = nodes[0];
    node.port.onmessage({ data: { type: "samples", pcm: voicedFrames() } });
    const result = session.stop();
    node.port.onmessage({ data: { type: "end" } });
    assert.equal((await result).size, 44 + voicedFrames().length * 2);
    assert.equal(stops, 1);
    const second = await startAssistantWavRecorder();
    second.cancel();
    await assert.rejects(second.result, { name: "AbortError" });
    assert.equal(stops, 2);
  } finally {
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator); else delete globalThis.navigator;
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else delete globalThis.window;
    globalThis.AudioContext = savedContext;
    globalThis.AudioWorkletNode = savedNode;
  }
});

it("reports unsupported browsers and microphone permission denial", async () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    await assert.rejects(startAssistantWavRecorder(), /unavailable/);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); } } } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: class {}, AudioWorkletNode: class {} } });
    await assert.rejects(startAssistantWavRecorder(), { name: "NotAllowedError" });
  } finally {
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator); else delete globalThis.navigator;
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else delete globalThis.window;
  }
});

it("hands monitoring to one recording, bounds pre-roll, and releases on device loss", async () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedContext = globalThis.AudioContext, savedNode = globalThis.AudioWorkletNode;
  const nodes = [];
  let stops = 0, activity = 0;
  const track = { getSettings: () => ({ echoCancellation: true }), stop: () => stops++, onended: null };
  const audioNode = () => ({ connect(other) { return other; }, disconnect() {} });
  class Context {
    state = "running"; audioWorklet = { addModule: async () => {} }; destination = {};
    createMediaStreamSource() { return audioNode(); }
    createGain() { return { ...audioNode(), gain: { value: 0 } }; }
    async close() { this.state = "closed"; }
  }
  class Node {
    constructor() { nodes.push(this); this.sent = []; this.port = { postMessage: (message) => this.sent.push(message) }; }
    connect(other) { return other; } disconnect() {}
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: Context, AudioWorkletNode: Node } });
  globalThis.AudioContext = Context; globalThis.AudioWorkletNode = Node;
  try {
    const session = await startAssistantWavRecorder(undefined, { onSamples: () => activity++ });
    const node = nodes[0];
    const send = (data) => node.port.onmessage({ data });
    send({ type: "samples", pcm: new Int16Array(16020).fill(123) });
    assert.equal(activity, 1);
    session.beginRecording();
    send({ type: "samples", pcm: Int16Array.of(234) }); // queued before reset acknowledgement
    send({ type: "recording-started" });
    send({ type: "samples", pcm: new Int16Array(4000).fill(345) }); // playback tail
    send({ type: "samples", pcm: voicedFrames() });
    send({ type: "end" });
    const bytes = new DataView(await (await session.result).arrayBuffer());
    assert.equal(bytes.byteLength, 44 + (16000 + voicedFrames().length) * 2);
    assert.equal(bytes.getInt16(44, true), 123);
    assert.equal(bytes.getInt16(44 + 16000 * 2, true), voicedFrames()[0]);
    assert.equal(stops, 1);
    const second = await startAssistantWavRecorder(undefined, { onSamples() {} });
    track.onended();
    await assert.rejects(second.result, /disconnected/);
    assert.equal(stops, 2);
    const silent = await startAssistantWavRecorder();
    nodes.at(-1).port.onmessage({ data: { type: "samples", pcm: new Int16Array(3200) } });
    nodes.at(-1).port.onmessage({ data: { type: "end" } });
    await assert.rejects(silent.result, /No speech was detected/);
    assert.equal(stops, 3);
    const preRollOnly = await startAssistantWavRecorder(undefined, { onSamples() {} });
    const sendOnly = (data) => nodes.at(-1).port.onmessage({ data });
    sendOnly({ type: "samples", pcm: voicedFrames() });
    preRollOnly.beginRecording();
    sendOnly({ type: "recording-started" });
    sendOnly({ type: "samples", pcm: new Int16Array(8000) });
    sendOnly({ type: "end" });
    await assert.rejects(preRollOnly.result, /No speech was detected/);
    assert.equal(stops, 4);
    track.getSettings = () => ({ echoCancellation: false });
    await assert.rejects(startAssistantWavRecorder(undefined, { onSamples() {} }), /echo cancellation/);
    assert.equal(stops, 5);
    track.getSettings = () => ({ echoCancellation: true });
    const automatic = await startAssistantWavRecorder();
    const automaticNode = nodes.at(-1);
    automaticNode.port.onmessage({ data: { type: "samples", pcm: voicedFrames() } });
    automaticNode.port.onmessage({ data: { type: "samples", pcm: new Int16Array(19200) } });
    assert.deepEqual(automaticNode.sent, ["stop"]);
    automaticNode.port.onmessage({ data: { type: "samples", pcm: new Int16Array(320) } });
    assert.deepEqual(automaticNode.sent, ["stop"]);
    automaticNode.port.onmessage({ data: { type: "end" } });
    assert.equal((await automatic.result).type, "audio/wav");
    assert.equal(stops, 6);
  } finally {
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator); else delete globalThis.navigator;
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else delete globalThis.window;
    globalThis.AudioContext = savedContext; globalThis.AudioWorkletNode = savedNode;
  }
});
