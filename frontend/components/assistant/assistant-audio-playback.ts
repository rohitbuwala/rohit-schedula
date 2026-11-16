export function playAssistantAudio(audio: Blob, callbacks: { onEnd: () => void; onError: () => void }) {
  const url = URL.createObjectURL(audio);
  let player: HTMLAudioElement;
  try { player = new Audio(url); }
  catch (error) { URL.revokeObjectURL(url); throw error; }
  let active = true;
  function stop() {
    if (!active) return;
    active = false;
    player.onended = null; player.onerror = null;
    player.pause(); player.removeAttribute("src"); player.load();
    URL.revokeObjectURL(url);
  }
  player.onended = () => { if (active) { stop(); callbacks.onEnd(); } };
  player.onerror = () => { if (active) { stop(); callbacks.onError(); } };
  try { void player.play().catch(() => { if (active) { stop(); callbacks.onError(); } }); }
  catch (error) { stop(); throw error; }
  return { stop };
}
