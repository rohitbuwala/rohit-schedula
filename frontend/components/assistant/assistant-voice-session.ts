type Recorder = { result: Promise<Blob>; stop: () => Promise<Blob>; cancel: () => void };
type VoiceState = "starting" | "listening" | "stopping" | "transcribing";

export async function startAssistantVoiceWhenReady(cleanup: Promise<void> | null, isCurrent: () => boolean, start: () => boolean) {
  if (cleanup) await cleanup;
  return isCurrent() && start();
}

// Ownership transfers only when accept returns true; every other path cancels.
export function handoffAssistantRecorder(recorder: Recorder, accept: () => boolean): boolean {
  let accepted = false;
  try { accepted = accept(); return accepted; }
  finally { if (!accepted) recorder.cancel(); }
}

export function createAssistantVoiceSession(options: {
  start: (signal: AbortSignal) => Promise<Recorder>;
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
  onState: (state: VoiceState) => void;
  onTranscript: (transcript: string) => void;
  onError: (error: unknown) => void;
  onEnd: () => void;
}) {
  const controller = new AbortController();
  let recorder: Recorder | undefined;
  let stopping = false;
  const done = (async () => {
    try {
      options.onState("starting");
      recorder = await options.start(controller.signal);
      if (controller.signal.aborted) { recorder.cancel(); return; }
      options.onState("listening");
      const audio = await recorder.result;
      if (controller.signal.aborted) return;
      options.onState("transcribing");
      const transcript = await options.transcribe(audio, controller.signal);
      if (!controller.signal.aborted) options.onTranscript(transcript);
    } catch (error) {
      if (!controller.signal.aborted) options.onError(error);
    } finally {
      if (!controller.signal.aborted) options.onEnd();
    }
  })();
  return {
    stop() {
      if (!recorder || stopping || controller.signal.aborted) return;
      stopping = true;
      options.onState("stopping");
      void recorder.stop().catch(() => {});
    },
    cancel() { controller.abort(); recorder?.cancel(); },
    done,
  };
}
