import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../../", import.meta.url));
const fixtureId = "00000000-0000-4000-8000-000000000001";
const appointment = { id: fixtureId, startsAt: "2026-11-12T05:00:00Z", endsAt: "2026-11-12T05:30:00Z", status: "scheduled" };
const doctorTimezone = "America/New_York";
const application = {
  id: fixtureId, specialty: "Cardiology", licenseRegion: "Test", licenseNumber: "FIXTURE",
  bio: null, status: "pending", submittedAt: "2026-11-12T05:00:00Z", reviewedAt: null,
};

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

let timeoutDetails;
async function until(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  if (timeoutDetails) console.log(await timeoutDetails());
  assert.fail(`Timed out waiting for ${label}`);
}

function browserPath() {
  const candidates = [
    process.env.ASSISTANT_E2E_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome",
  ];
  const executable = candidates.find((path) => path && existsSync(path));
  assert.ok(executable, "Set ASSISTANT_E2E_BROWSER to an installed Chromium browser executable.");
  return executable;
}

async function startBrowser(t) {
  const executable = browserPath();
  const temporaryRoot = resolve(tmpdir());
  const profile = await mkdtemp(join(temporaryRoot, "medrella-assistant-e2e-"));
  const child = spawn(executable, [
    "--headless=new", "--no-first-run", "--disable-background-networking", "--remote-debugging-pipe",
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let buffer = "";
  let sequence = 0;
  function failPending(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  child.on("error", failPending);
  child.on("exit", () => failPending(new Error("The E2E browser exited.")));
  child.stdio[3].on("error", failPending);
  child.stdio[4].setEncoding("utf8").on("data", (text) => {
    buffer += text;
    const messages = buffer.split("\0");
    buffer = messages.pop();
    for (const message of messages) {
      if (!message) continue;
      const { id, result, error } = JSON.parse(message);
      const request = pending.get(id);
      if (!request) continue;
      pending.delete(id);
      if (error) request.reject(new Error(`Browser command failed: ${request.method}`));
      else request.resolve(result);
    }
  });
  t.after(async () => {
    await stop(child);
    if (dirname(resolve(profile)) === temporaryRoot) {
      await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
    }
  });
  function command(method, params = {}, sessionId) {
    const id = ++sequence;
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 60_000);
      pending.set(id, { method,
        resolve: (value) => { clearTimeout(timer); resolveCommand(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }
  const { targetId } = await command("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => command(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error("Browser evaluation failed.");
    return result.result.value;
  };
  return { send, evaluate };
}

async function stop(child) {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await Promise.race([exited, pause(3000, undefined, { ref: false })]);
  }
}

it("renders the role-aware assistant in Chromium and submits through the Next.js API rewrite", { timeout: 240_000 }, async (t) => {
  const calls = [];
  const bookingWrites = [];
  let loseBookingResponse = false;
  let holdReply;
  let failSynthesis = false;
  const backend = createServer(async (req, res) => {
    const fixture = /(?:^|;\s*)medrella-fixture=(patient|doctor|pending)/.exec(req.headers.cookie ?? "")?.[1];
    const role = fixture === "doctor" ? "doctor" : "patient";
    const json = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url?.startsWith('/api/appointments/availability?')) {
      const query = new URL(req.url, 'http://fixture').searchParams;
      const startsAt = new Date(`${query.get('date')}T04:30:00.000Z`);
      return json({ doctorProfileId: query.get('doctorProfileId'), date: query.get('date'), timezone: 'Asia/Kolkata', durationMinutes: 30,
        slots: [{ startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 1800000).toISOString() }] });
    }
    if (req.method === 'POST' && req.url === '/api/appointments') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      bookingWrites.push({ url: req.url, key: req.headers['idempotency-key'], payload });
      if (loseBookingResponse) { loseBookingResponse = false; req.socket.destroy(); return; }
      return json({ id: fixtureId, startsAt: payload.startsAt, endsAt: payload.endsAt, status: 'pending_payment', holdExpiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (req.url === `/api/appointments/${fixtureId}/hold`) return json({ id: fixtureId, doctorProfileId: fixtureId, doctorName: 'Dr. Fixture', specialty: 'Cardiology', consultationFeeInr: 500, startsAt: '2027-01-04T04:30:00.000Z', endsAt: '2027-01-04T05:00:00.000Z', holdExpiresAt: new Date(Date.now() + 600000).toISOString(), status: 'pending_payment' });
    if (req.method === 'POST' && req.url === '/api/payments/create-order') { bookingWrites.push({ url: req.url }); return json({ orderId: 'order-fixture', amountPaise: 50000, currency: 'INR', keyId: 'test-key', appointmentId: fixtureId }); }
    if (req.method === 'POST' && req.url === '/api/payments/verify') { bookingWrites.push({ url: req.url }); return json({ success: true, paymentId: 'payment-fixture' }); }
    switch (req.url) {
      case '/api/doctors': return json([{ id: fixtureId, name: 'Dr. Fixture', specialty: 'Cardiology', consultationFeeInr: 500 }]);
      case "/api/auth/get-session":
        return json(fixture ? { user: { id: fixture, role, name: "Browser Fixture", email: "fixture@example.test" }, session: { id: "fixture-session" } } : null);
      case "/api/doctors/me":
        return json({}, role === "doctor" ? 200 : 403);
      case "/api/doctor-applications/me":
        return json(fixture === "pending" ? application : null);
      case "/api/notifications/unread-count":
        return json({ count: 0 });
      case "/api/assistant/voice/transcribe": {
        for await (const chunk of req) { void chunk; }
        return json({ transcript: "Show my appointments" });
      }
      case "/api/assistant/voice/synthesize": {
        if (failSynthesis) return json({}, 503);
        res.writeHead(200, { "Content-Type": "audio/wav" });
        return res.end("fixture audio");
      }
      case "/api/assistant/chat": {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const { message } = JSON.parse(Buffer.concat(chunks));
        if (message === 'Book an appointment') return json({ tool: 'start_booking', reply: 'Choose a doctor to start a booking draft.', data: null });
        calls.push({ fixture, message });
        if (fixture === "pending") return json({}, 403);
        if (message === "Rate limit fixture") return json({}, 429);
        if (role === "doctor") {
          if (message.includes(fixtureId)) return json({
            tool: "appointment_details", reply: "Appointment details", data: { ...appointment, timezone: doctorTimezone },
          });
          return json({ tool: "today_appointments", reply: "Here are today’s appointments.", data: {
            date: "2026-11-12", timezone: doctorTimezone, appointments: [appointment], hasMore: false,
          } });
        }
        await new Promise((release) => { holdReply = release; });
        return json({ tool: "list_appointments", reply: "Here are your appointments.", data: {
          filter: "all",
          appointments: [{ ...appointment, period: "upcoming", doctor: { id: fixtureId, name: "Dr. Fixture", specialty: "Cardiology" } }],
          hasMore: false,
        } });
      }
      default:
        return json([]);
    }
  });
  const backendPort = await listen(backend);
  t.after(() => {
    holdReply?.();
    backend.closeAllConnections();
    return new Promise((done) => backend.close(done));
  });
  const reservation = createServer();
  const frontendPort = await listen(reservation);
  await new Promise((done) => reservation.close(done));
  const url = `http://127.0.0.1:${frontendPort}`;
  const app = spawn(process.execPath, [join(frontend, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(frontendPort)], {
    cwd: frontend, stdio: "ignore", windowsHide: true,
    env: { ...process.env, ASSISTANT_E2E: "1", NEXT_PUBLIC_AUTH_URL: `http://127.0.0.1:${backendPort}`, NEXT_TELEMETRY_DISABLED: "1" },
  });
  t.after(() => stop(app));
  await until(async () => {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error("Next.js exited before the browser test could start.");
    try { return (await fetch(url + "/api/auth/get-session", { signal: AbortSignal.timeout(2000) })).ok; }
    catch (error) {
      if (["EACCES", "EPERM"].includes(error.cause?.code)) {
        throw new Error(`The execution environment denied the E2E loopback connection (${error.cause.code}).`);
      }
      return false;
    }
  }, "the Next.js rewrite");
  const { send, evaluate } = await startBrowser(t);
  timeoutDetails = () => evaluate(`JSON.stringify({ active:document.activeElement?.outerHTML, body:document.body.innerText.slice(-1800) })`);
  await send("Page.enable");
  await send("Page.bringToFront");
  await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["https://checkout.razorpay.com/*"] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => {
        window.voiceStarted = (window.voiceStarted || 0) + 1;
        const track = { getSettings: () => ({ echoCancellation: true }), stop: () => { window.voiceStopped = (window.voiceStopped || 0) + 1; } };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }
    } });
    const audioNode = () => ({ connect(other) { return other; }, disconnect() {} });
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; this.destination = {}; }
      createMediaStreamSource() { return audioNode(); }
      createGain() { return { ...audioNode(), gain: { value: 1 } }; }
      async close() { this.state = 'closed'; }
    };
    window.AudioWorkletNode = class {
      constructor() { window.lastWorklet = this; this.port = { postMessage: (message) => queueMicrotask(() => {
        if (message === 'reset') {
          this.port.onmessage?.({ data: { type: 'recording-started' } });
          this.port.onmessage?.({ data: { type: 'samples', pcm: new Int16Array(4000) } });
          return;
        }
        const speech = Int16Array.from({length: 3200}, (_, i) => Math.round(4000 * (Math.floor(i / 320) % 2 ? 1 : 0.45) * Math.sin(2 * Math.PI * 180 * i / 16000)));
        this.port.onmessage?.({ data: { type: 'samples', pcm: speech } });
        this.port.onmessage?.({ data: { type: 'end' } });
      }) }; }
      connect(other) { return other; }
      disconnect() {}
    };
    window.Audio = class {
      constructor() { window.testAudio = this; }
      async play() {}
      pause() {}
      removeAttribute() {}
      load() {}
    };
    window.Razorpay = class {
      constructor(options) { this.options = options; }
      on() {}
      open() { this.options.handler({ razorpay_order_id: 'order-fixture', razorpay_payment_id: 'payment-fixture', razorpay_signature: 'fixture' }); }
    };
  ` });
  async function visit(fixture, route) {
    await send("Network.setCookie", { name: "medrella-fixture", value: fixture, url });
    await send("Page.navigate", { url: url + route });
    await until(() => evaluate(`location.pathname === ${JSON.stringify(route)} && document.readyState === 'complete'`), route);
  }
  const hasText = (text) => text === "Start voice chat" ? evaluate("Boolean(document.querySelector('button[aria-label=\"Live voice conversation\"][aria-checked=\"false\"]'))") : evaluate(`document.body?.innerText?.includes(${JSON.stringify(text)})`);
  const launcherLabel = "Medrella AI Assistant";
  const button = (label) => `Array.from(document.querySelectorAll('button')).find(b => [b.getAttribute('aria-label'), b.getAttribute('title'), b.textContent.trim()].includes(${JSON.stringify(label)}) && !b.disabled && b.offsetWidth)`;
  const click = async (label) => {
    await until(() => evaluate(`Boolean(${button(label)})`), label);
    await evaluate(`(${button(label)}).click()`);
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await visit("patient", "/patient/dashboard");
  await until(() => evaluate(`Boolean(${button(launcherLabel)})`), "floating launcher");
  assert.equal(await evaluate(`(() => {
    const launcher = ${button(launcherLabel)};
    const rect = launcher.getBoundingClientRect();
    return launcher.getAttribute('aria-expanded') === 'false' &&
      rect.width === 50 && rect.height === 50 &&
      document.getElementById(launcher.getAttribute('aria-controls')).getClientRects().length === 0 &&
      innerWidth - rect.right >= 16 && innerWidth - rect.right <= 24 &&
      innerHeight - rect.bottom >= 16 && innerHeight - rect.bottom <= 64;
  })()`), true);
  await click(launcherLabel);
  await until(() => evaluate("document.activeElement?.closest('section[id$=panel]')?.querySelector('input') === document.activeElement"), "composer focus");
  await click("Start voice input");
  await until(() => hasText("Listening"), "voice listening state");
  assert.equal(calls.length, 0);
  await click("Stop voice input");
  await until(() => evaluate("document.querySelector('section[id$=panel] input').value === 'Show my appointments'"), "voice transcript");
  await until(() => evaluate(`Boolean(${button("Start voice input")})`), "voice input stopped");
  await evaluate("(() => { const input = document.querySelector('section[id$=panel] input'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); })()");
  await send("Input.insertText", { text: " please" });
  assert.equal(await evaluate("document.querySelector('section[id$=panel] input').value"), "Show my appointments please");
  assert.equal(calls.length, 0);
  await click("Start voice input");
  await until(() => hasText("Listening"), "second voice listening state");
  await click("Close assistant");
  await until(() => evaluate("window.voiceStopped >= 2"), "voice input aborted on close");
  await click(launcherLabel);
  await until(() => evaluate("document.activeElement?.closest('section[id$=panel]')?.querySelector('input') === document.activeElement"), "composer refocused");
  assert.equal(await evaluate("document.activeElement.value"), "Show my appointments please");
  assert.equal(await evaluate(`Boolean(${button(launcherLabel)})`), false);
  assert.equal(await evaluate(`Boolean(${button("Resize assistant with arrow keys")})`), false);
  assert.equal(await evaluate(`(() => {
    const rect = document.activeElement.closest('section').getBoundingClientRect();
    return rect.left >= 16 && rect.right <= innerWidth - 16 && rect.top >= 64 && rect.bottom <= innerHeight - 16;
  })()`), true);
  assert.equal(await hasText("Check availability"), true);
  assert.equal(await hasText("My schedule"), false);
  await click("My appointments");
  await until(() => calls.length === 1, "patient API call");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Send message').disabled"), true);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  holdReply();
  await until(() => hasText("Dr. Fixture"), "appointment result");
  assert.deepEqual(calls[0], { fixture: "patient", message: "Show my appointments" });
  await evaluate("document.querySelector('section[id$=panel] input').focus()");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(() => evaluate(`(${button(launcherLabel)}) === document.activeElement`), "launcher focus restored");
  await click(launcherLabel);
  await until(() => evaluate("document.activeElement?.closest('section[id$=panel]')?.querySelector('input') === document.activeElement"), "composer refocused");
  assert.equal(await hasText("Dr. Fixture"), true);
  await send("Input.insertText", { text: "Rate limit fixture" });
  await click("Send message");
  await until(() => hasText("The assistant request limit was reached."), "rate-limit message");

  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await visit("doctor", "/doctor/dashboard");
  await click(launcherLabel);
  const resizeGrip = button("Resize assistant with arrow keys");
  await until(() => evaluate(`Boolean(${resizeGrip})`), "desktop resize grip");
  const rect = (element) => evaluate(`(${element}).getBoundingClientRect().toJSON()`);
  const panel = "document.getElementById(document.querySelector('button[aria-label=\"Medrella AI Assistant\"]').getAttribute('aria-controls'))";
  const header = `${panel}.querySelector('header')`;
  async function drag(x, y, endX, endY) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: endX, y: endY, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: endY, button: "left", buttons: 0, clickCount: 1 });
  }
  const initial = await rect(panel);
  const grip = await rect(resizeGrip);
  await drag(grip.x + grip.width / 2, grip.y + grip.height / 2, grip.x - 100, grip.y - 80);
  await until(async () => { const current = await rect(panel); return current.width > initial.width && current.height > initial.height; }, "panel resize");
  const enlarged = await rect(panel);
  assert.ok(enlarged.width > initial.width && enlarged.height > initial.height);
  const titleBar = await rect(header);
  await drag(titleBar.x + 100, titleBar.y + 30, 1, 1);
  await until(async () => { const current = await rect(panel); return current.left === 16 && current.top === 16; }, "panel move");
  const moved = await rect(panel);
  assert.equal(moved.left, 16);
  assert.equal(moved.top, 16);
  assert.equal(moved.width, enlarged.width);
  await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 400, deviceScaleFactor: 1, mobile: false });
  await until(async () => {
    const resized = await rect(panel);
    return resized.left >= 16 && resized.right <= 784 && resized.top >= 16 && resized.bottom <= 384;
  }, "panel clamped after viewport resize");
  assert.equal(await hasText("My schedule"), true);
  assert.equal(await hasText("Find a cardiologist"), false);
  await click("Today’s appointments");
  await click("View details");
  await until(() => hasText("Appointment details"), "doctor appointment details");
  assert.equal(calls.at(-1).message, `Show appointment details ${fixtureId}`);
  const displayedTimes = await evaluate(`(() => {
    const log = document.querySelector('[role="log"]');
    const detailsButton = Array.from(log.querySelectorAll('button')).find(b => b.textContent.trim() === 'View details');
    const list = detailsButton.closest('li').textContent;
    const detail = log.lastElementChild.textContent;
    const format = new Intl.DateTimeFormat('en-IN', {dateStyle: 'medium', timeStyle: 'short', timeZone: ${JSON.stringify(doctorTimezone)}});
    const expected = format.formatRange(new Date(${JSON.stringify(appointment.startsAt)}), new Date(${JSON.stringify(appointment.endsAt)}));
    return {list, detail, expected};
  })()`);
  assert.ok(displayedTimes.list.includes(displayedTimes.expected));
  assert.ok(displayedTimes.detail.includes(`${displayedTimes.expected} (${doctorTimezone})`));
  assert.ok(displayedTimes.detail.includes('Scheduled'));
  await click("Close assistant");
  await until(() => evaluate(`(${button(launcherLabel)}) === document.activeElement`), "close button returns focus to launcher");

  await click(launcherLabel);
  await click("Start voice chat");
  await until(() => hasText("Listening"), "continuous recording");
  const started = await evaluate("window.voiceStarted");
  await click("Stop voice input");
  await until(() => evaluate("Boolean(window.testAudio?.onended)"), "continuous reply playback");
  assert.equal(await evaluate("window.voiceStarted"), started);
  assert.equal(await evaluate("window.voiceStopped === window.voiceStarted"), true);
  await evaluate("window.testAudio.onended()");
  await until(() => evaluate(`window.voiceStarted === ${started + 1}`), "microphone restarts after playback");
  await click("Stop voice input");
  await until(() => evaluate("Boolean(window.testAudio?.onended)"), "second continuous reply playback");
  await evaluate("window.lateEnd = window.testAudio.onended");
  await click("Stop speaking");
  await evaluate("window.lateEnd()");
  assert.equal(await evaluate("window.voiceStarted"), started + 1);
  assert.equal(await hasText("Start voice chat"), true);
  await click("Start voice chat");
  await until(() => hasText("Listening"), "continuous recording after stop");
  await click("End voice chat");
  await until(() => evaluate("window.voiceStopped === window.voiceStarted"), "microphone stops when disabled");
  await click("Start voice chat");
  await until(() => hasText("Listening"), "continuous recording before failure");
  failSynthesis = true;
  await click("Stop voice input");
  await until(() => hasText("Start voice chat"), "continuous mode stops on synthesis failure");
  assert.equal(await evaluate("window.voiceStopped === window.voiceStarted"), true);
  failSynthesis = false;
  await click("Start voice chat");
  await until(() => hasText("Listening"), "continuous recording before close");
  await click("Close assistant");
  await until(() => evaluate("window.voiceStopped === window.voiceStarted"), "close stops continuous microphone");

  await click(launcherLabel);
  await click("Start voice chat");
  await until(() => hasText("Listening"), "barge-in initial recording");
  await click("Barge-in: Off");
  await click("Stop voice input");
  await until(() => evaluate("Boolean(window.testAudio?.onended && window.lastWorklet?.port.onmessage && window.voiceStarted > window.voiceStopped)"), "barge-in monitor");
  const beforeInterrupt = await evaluate("window.voiceStarted");
  const callsBeforeInterrupt = calls.length;
  await evaluate(`(() => {
    window.lateBargeEnd = window.testAudio.onended;
    const frame = Int16Array.from({length: 320}, (_, i) => Math.round(5000 * Math.sin(2 * Math.PI * 200 * i / 16000)));
    for (let i = 0; i < 80; i++) window.lastWorklet.port.onmessage({data: {type: 'samples', pcm: frame}});
  })()`);
  await until(() => hasText("Listening"), "barge-in recording");
  await evaluate("window.lateBargeEnd()");
  assert.equal(await evaluate("window.voiceStarted"), beforeInterrupt);
  await click("Stop voice input");
  await until(() => hasText("Review the interrupted message"), "interrupted transcript review");
  assert.equal(calls.length, callsBeforeInterrupt);
  assert.equal(await evaluate("window.voiceStopped === window.voiceStarted"), true);
  await click("Close assistant");

  await click(launcherLabel);
  await click("Start voice chat");
  await until(() => hasText("Listening"), "recording before barge toggle race");
  await click("Barge-in: Off");
  await click("Stop voice input");
  await until(() => evaluate("Boolean(window.testAudio?.onended && window.voiceStarted > window.voiceStopped)"), "monitor before toggle race");
  await evaluate("window.lateMonitor = window.lastWorklet.port.onmessage");
  await click("Barge-in: On");
  await until(() => evaluate("window.voiceStopped === window.voiceStarted"), "toggle releases monitor");
  await evaluate("window.lateMonitor({data: {type: 'samples', pcm: new Int16Array(320)}})");
  assert.equal(await evaluate("Boolean(window.testAudio?.onended)"), true);
  await click("Close assistant");
  await evaluate("window.lateMonitor({data: {type: 'samples', pcm: new Int16Array(320)}})");
  assert.equal(await evaluate("window.voiceStopped === window.voiceStarted"), true);

  await visit("patient", "/patient/dashboard");
  await click(launcherLabel);
  await click("Book an appointment");
  await until(() => evaluate("Boolean(document.querySelector('section[aria-label=\"Appointment booking draft\"]'))"), "booking draft");
  await evaluate(`Array.from(document.querySelectorAll('section[aria-label="Appointment booking draft"] button')).find(b => b.textContent.includes('Dr. Fixture')).click()`);
  await evaluate("document.querySelector('section[id$=panel] input').focus()");
  await send("Input.insertText", { text: "tomorrow" });
  await click("Send message");
  await until(() => evaluate("Boolean(document.querySelector('section[aria-label=\"Appointment booking draft\"] button[aria-pressed][data-booking-slot]'))"), "available booking slot");
  await evaluate("document.querySelector('section[aria-label=\"Appointment booking draft\"] button[data-booking-slot]').click()");
  assert.deepEqual(bookingWrites, []);
  loseBookingResponse = true;
  await click("Confirm Booking");
  await until(() => hasText("We could not confirm the result."), "uncertain booking result");
  assert.equal(bookingWrites.length, 1);
  await send("Page.reload");
  await until(() => hasText("A previous booking attempt needs recovery."), "restored booking attempt");
  await click("Retry Confirmation");
  await until(() => hasText("Slot held temporarily."), "appointment hold");
  assert.equal(bookingWrites.length, 2);
  assert.equal(bookingWrites[0].key, bookingWrites[1].key);
  assert.deepEqual(bookingWrites[0].payload, bookingWrites[1].payload);
  assert.match(bookingWrites[0].key, /^[\da-f-]{36}$/i);
  assert.equal(bookingWrites[0].payload.doctorProfileId, fixtureId);
  await click("Reset Draft");
  assert.equal(await evaluate("Boolean(document.querySelector('section[aria-label=\"Appointment booking draft\"]'))"), false);
  await click("Close assistant");

  const countBeforeRecovery = bookingWrites.length;
  await send("Page.navigate", { url: `${url}/patient/book-appointment?holdId=${fixtureId}` });
  await until(() => hasText("10-Minute Slot Hold Active"), "recovered hold");
  assert.equal(bookingWrites.length, countBeforeRecovery);
  await send("Page.reload");
  await until(() => hasText("10-Minute Slot Hold Active"), "hold recovered after reload");
  assert.equal(bookingWrites.length, countBeforeRecovery);
  await click("Complete Payment (₹500)");
  await until(() => hasText("Consultation Confirmed & Payment Verified!"), "verified payment");
  assert.deepEqual(bookingWrites.slice(countBeforeRecovery).map((item) => item.url), ['/api/payments/create-order', '/api/payments/verify']);

  await visit("pending", "/doctor/dashboard");
  assert.equal(await evaluate(`Boolean(${button(launcherLabel)})`), false);
  await visit("pending", "/patient/dashboard");
  assert.equal(await evaluate(`Boolean(${button(launcherLabel)})`), false);
});
