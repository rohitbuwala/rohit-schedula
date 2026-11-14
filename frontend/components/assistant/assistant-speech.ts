export function appendSpeechTranscript(draft: string, transcript: string) {
  return [draft.trimEnd(), transcript].filter(Boolean).join(" ").slice(0, 1000);
}

export function speechErrorMessage(code: string) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was denied. Allow access in your browser settings or type your message.";
    case "audio-capture":
      return "No microphone is available. Check your device or type your message.";
    case "no-speech":
      return "No speech was detected. Try again or type your message.";
    default:
      return "Voice input could not be completed. Try again or type your message.";
  }
}
