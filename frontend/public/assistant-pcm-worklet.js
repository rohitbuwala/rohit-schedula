class AssistantPcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.total = 0;
    this.phase = 0;
    this.sum = 0;
    this.weight = 0;
    this.done = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") this.finish();
      if (event.data === "reset") {
        this.total = 0;
        this.port.postMessage({ type: "recording-started" });
      }
    };
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this.port.postMessage({ type: "end" });
  }

  process(inputs) {
    if (this.done) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const output = [];
    const step = 16000 / sampleRate;
    for (let i = 0; i < channels[0].length && this.total < 480000; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      let remaining = step;
      while (remaining > 0 && this.total < 480000) {
        const portion = Math.min(remaining, 1 - this.phase);
        this.sum += sample * portion;
        this.weight += portion;
        this.phase += portion;
        remaining -= portion;
        if (this.phase >= 1 - 1e-10) {
          const value = Math.max(-1, Math.min(1, this.sum / this.weight));
          output.push(value < 0 ? Math.round(value * 32768) : Math.round(value * 32767));
          this.total++;
          this.phase = 0;
          this.sum = 0;
          this.weight = 0;
        }
      }
    }
    if (output.length) {
      const pcm = Int16Array.from(output);
      this.port.postMessage({ type: "samples", pcm }, [pcm.buffer]);
    }
    if (this.total >= 480000) this.finish();
    return !this.done;
  }
}
registerProcessor("assistant-pcm-recorder", AssistantPcmRecorder);
