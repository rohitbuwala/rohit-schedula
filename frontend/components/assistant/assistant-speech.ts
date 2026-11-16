import type { AssistantResponse } from "../../lib/assistant-api.ts";

export function assistantReplyLanguage(message: string, preference: "auto" | "en" | "hi"): "en" | "hi" {
  return preference === "auto" ? (/\p{Script=Devanagari}/u.test(message) ? "hi" : "en") : preference;
}

export function assistantSpokenReply(result: AssistantResponse): string {
  const data = result.data;
  if (!data) return result.reply;
  const entries = "appointments" in data ? data.appointments.slice(0, 3)
    : "slot" in data && data.slot ? [data.slot]
      : result.tool === "appointment_details" ? [result.data] : [];
  const timezone = "timezone" in data ? data.timezone : "Asia/Kolkata";
  const format = new Intl.DateTimeFormat(assistantReplyLanguage(result.reply, "auto") === "hi" ? "hi-IN" : "en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: timezone === "IST" ? "Asia/Kolkata" : timezone,
  });
  // Speak the times as well as the introduction. Patient names stay on the
  // authenticated cards and are not added to external speech-provider requests.
  return [result.reply, ...entries.map(item => `${format.format(new Date(item.startsAt))} – ${format.format(new Date(item.endsAt))}`)]
    .join(" ").slice(0, 1000);
}

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
