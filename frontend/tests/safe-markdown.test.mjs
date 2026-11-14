import assert from "node:assert/strict";
import { it } from "node:test";
import { existsSync } from "node:fs";
import { parseSafeInline, SafeMarkdown } from "../components/assistant/safe-markdown.ts";

it("keeps the extensionless chatbot import free of shadowing modules", () => {
  // Next's Webpack resolver prefers .tsx over .ts. A same-name .tsx
  // re-export of './safe-markdown' resolves to itself and overflows the stack.
  assert.equal(existsSync(new URL("../components/assistant/safe-markdown.tsx", import.meta.url)), false);
});

it("parses bold, italic, and inline code correctly", () => {
  const inline = parseSafeInline("Hello **Dr. Sharma**, your slot is at `10:00 AM` and *confirmed*.");
  assert.equal(Array.isArray(inline), true);

  // inline contains: "Hello ", <strong>Dr. Sharma</strong>, ", your slot is at ", <code>10:00 AM</code>, " and ", <em>confirmed</em>, "."
  assert.equal(inline[0], "Hello ");
  assert.equal(inline[1].type, "strong");
  assert.equal(inline[1].props.children[0], "Dr. Sharma");
  assert.equal(inline[2], ", your slot is at ");
  assert.equal(inline[3].type, "code");
  assert.equal(inline[3].props.children, "10:00 AM");
  assert.equal(inline[4], " and ");
  assert.equal(inline[5].type, "em");
  assert.equal(inline[5].props.children[0], "confirmed");
  assert.equal(inline[6], ".");
});

it("keeps malicious script and HTML tags as inert string literals without executing or dangerously injecting", () => {
  const malicious = '<script>alert("xss")</script><img src="x" onerror="evil()" /><b>bold</b>';
  const inline = parseSafeInline(malicious);

  // Must not create script or img DOM nodes; must be plain string elements
  assert.equal(inline.length, 1);
  assert.equal(typeof inline[0], "string");
  assert.equal(inline[0], malicious);
});

it("renders bullet lists and paragraphs properly", () => {
  const markdownText = "Here are options:\n- Slot 1: 10 AM\n- Slot 2: 11 AM\n\nPlease choose one.";
  const rendered = SafeMarkdown({ content: markdownText });

  assert.equal(rendered.type, "div");
  const children = rendered.props.children;
  assert.equal(children.length, 3); // paragraph 1, list (ul), paragraph 2

  // paragraph 1
  assert.equal(children[0].type, "p");
  // list
  assert.equal(children[1].type, "ul");
  assert.equal(children[1].props.children.length, 2);
  assert.equal(children[1].props.children[0].type, "li");
  assert.equal(children[1].props.children[1].type, "li");
  // paragraph 2
  assert.equal(children[2].type, "p");
});

it("handles empty or blank content gracefully", () => {
  assert.equal(SafeMarkdown({ content: "" }), null);
  assert.deepEqual(parseSafeInline(""), []);
});
