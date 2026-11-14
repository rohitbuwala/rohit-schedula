export const MAX_SAMPLES = 480_000;
const PRE_ROLL_SAMPLES = 16_000;
const RATE = 16_000;

// Process 20 ms frames across worklet messages. End only after speech-like
// activity followed by 1.2 seconds of quiet; a short pause stays in one turn.
export function createEndOfSpeechDetector() {
  let count = 0, energy = 0, crossings = 0, previous = 0;
  let active = 0, quiet = 0, peak = 0;
  let heardSpeech = false, ended = false;
  return (samples: Int16Array) => {
    if (ended) return false;
    for (const sample of samples) {
      const value = sample / 32768;
      energy += value * value;
      if (count && (value >= 0) !== (previous >= 0)) crossings++;
      previous = value;
      if (++count < 320) continue;
      const rms = Math.sqrt(energy / count);
      const rate = crossings / 319;
      if (rms >= 0.003 && rate >= 0.006 && rate <= 0.4) {
        active++;
        peak = Math.max(peak, rms);
        if (active >= 10) heardSpeech = true;
      }
      // Laptop gain control can flatten speech, while a fan can keep the
      // microphone above absolute silence. Compare pauses to the voice level.
      quiet = heardSpeech && rms < Math.max(0.003, peak * 0.25) ? quiet + 1 : 0;
      count = 0; energy = 0; crossings = 0;
      if (quiet >= 60) { ended = true; return true; }
    }
    return false;
  };
}

// A conservative activity heuristic, not speaker identification or a speech recognizer.
export function hasAssistantSpeech(samples: Int16Array): boolean {
  let active = 0;
  for (let start = 0; start + 320 <= samples.length; start += 320) {
    let energy = 0, crossings = 0;
    for (let i = start; i < start + 320; i++) {
      const value = samples[i] / 32768;
      energy += value * value;
      if (i > start && (samples[i] >= 0) !== (samples[i - 1] >= 0)) crossings++;
    }
    const rms = Math.sqrt(energy / 320);
    const rate = crossings / 319;
    if (rms >= 0.003 && rate >= 0.006 && rate <= 0.4) {
      active++;
    }
  }
  // This is only an activity gate. Let transcription decide whether activity
  // contains words; do not reject speech flattened by microphone gain control.
  return active >= 10;
}

export function encodeAssistantWav(samples: Int16Array): Blob {
  if (!samples.length || samples.length > MAX_SAMPLES) throw new Error("Invalid recording length.");
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return new Blob([bytes], { type: "audio/wav" });
}

/** Records in memory only. Call cancel on panel dismissal or when changing modes. */
export async function startAssistantWavRecorder(signal?: AbortSignal, monitor?: { onSamples: (samples: Int16Array) => void }) {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
    throw new Error("Audio recording is unavailable in this browser.");
  }
  if (signal?.aborted) throw new DOMException("Recording cancelled.", "AbortError");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  let context: AudioContext | undefined;
  const release = () => {
    stream.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") void context.close().catch(() => {});
  };
  try {
    if (signal?.aborted) throw new DOMException("Recording cancelled.", "AbortError");
    if (monitor && stream.getAudioTracks()[0]?.getSettings().echoCancellation !== true) {
      throw new Error("Barge-in requires microphone echo cancellation.");
    }
    context = new AudioContext();
    if (context.state === "suspended") await context.resume();
    await context.audioWorklet.addModule("/assistant-pcm-worklet.js");
    if (signal?.aborted) throw new DOMException("Recording cancelled.", "AbortError");
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "assistant-pcm-recorder");
    const muted = context.createGain();
    muted.gain.value = 0;
    source.connect(node).connect(muted).connect(context.destination);
    const samples = new Int16Array(MAX_SAMPLES);
    const preRoll = monitor ? new Int16Array(PRE_ROLL_SAMPLES) : null;
    let preCount = 0, prePosition = 0, validationStart = 0;
    let count = 0;
    let monitoring = Boolean(monitor);
    let waitingForReset = false;
    let discardSamples = 0;
    let finished = false;
    const endOfSpeech = createEndOfSpeechDetector();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveResult!: (blob: Blob) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<Blob>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // A cancelled recording may have no consumer yet.
    void result.catch(() => {});
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      node.port.onmessage = null;
      stream.getTracks().forEach((track) => { track.onended = null; });
      preRoll?.fill(0);
      node.disconnect(); source.disconnect(); muted.disconnect();
      release();
    };
    function cancel() {
      if (finished) return;
      finished = true;
      cleanup();
      rejectResult(new DOMException("Recording cancelled.", "AbortError"));
    }
    signal?.addEventListener("abort", cancel, { once: true });
    node.onprocessorerror = () => {
      if (finished) return;
      finished = true;
      cleanup();
      rejectResult(new Error("Audio recording failed."));
    };
    stream.getTracks().forEach((track) => { track.onended = () => {
      if (finished) return;
      finished = true; cleanup(); rejectResult(new Error("Microphone disconnected."));
    }; });
    node.port.onmessage = (event: MessageEvent) => {
      if (finished) return;
      if (event.data?.type === "samples" && event.data.pcm instanceof Int16Array) {
        let chunk: Int16Array = event.data.pcm;
        if (waitingForReset) return;
        if (monitoring) {
          if (preRoll) for (const sample of chunk) {
            preRoll[prePosition] = sample;
            prePosition = (prePosition + 1) % preRoll.length;
            preCount = Math.min(preCount + 1, preRoll.length);
          }
          monitor?.onSamples(chunk); return;
        }
        if (discardSamples) {
          const discard = Math.min(discardSamples, chunk.length);
          discardSamples -= discard;
          chunk = chunk.subarray(discard);
        }
        if (count + chunk.length > MAX_SAMPLES) chunk = chunk.subarray(0, MAX_SAMPLES - count);
        samples.set(chunk, count); count += chunk.length;
        if (!timer && (endOfSpeech(chunk) || count === MAX_SAMPLES)) {
          node.port.postMessage("stop");
          timer = setTimeout(cancel, 3000);
        }
      } else if (event.data?.type === "recording-started" && waitingForReset) {
        waitingForReset = false;
      } else if (event.data?.type === "end") {
        finished = true;
        cleanup();
        try {
          if (!hasAssistantSpeech(samples.subarray(validationStart, count))) throw new Error("No speech was detected. Try again or type your message.");
          resolveResult(encodeAssistantWav(samples.subarray(0, count)));
        } catch { rejectResult(new Error("No speech was detected. Try again or type your message.")); }
      }
    };
    if (signal?.aborted) cancel();
    return {
      result,
      beginRecording() {
        if (finished || !monitoring) return;
        monitoring = false;
        waitingForReset = true;
        discardSamples = 4000;
        count = preCount;
        if (preRoll) {
          const first = (prePosition - preCount + preRoll.length) % preRoll.length;
          for (let i = 0; i < preCount; i++) samples[i] = preRoll[(first + i) % preRoll.length];
          preRoll.fill(0);
        }
        validationStart = count;
        node.port.postMessage("reset");
      },
      stop() {
        if (!finished && !timer) {
          node.port.postMessage("stop");
          timer = setTimeout(cancel, 3000);
        }
        return result;
      },
      cancel,
    };
  } catch (error) {
    release();
    throw error;
  }
}
