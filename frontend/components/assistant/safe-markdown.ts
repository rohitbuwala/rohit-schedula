import React, { type ReactNode } from "react";

// Matches inline markdown:
// - inline code: `code`
// - bold: **bold** or __bold__
// - italic: *italic* or _italic_
const INLINE_REGEX = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;

export function parseSafeInline(text: string): ReactNode[] {
  if (!text) return [];
  const parts = text.split(INLINE_REGEX);
  const elements: ReactNode[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      elements.push(
        React.createElement(
          "code",
          { key: i, className: "rounded bg-slate-200/70 px-1 py-0.5 font-mono text-xs text-slate-800" },
          part.slice(1, -1)
        )
      );
    } else if (
      (part.startsWith("**") && part.endsWith("**") && part.length >= 4) ||
      (part.startsWith("__") && part.endsWith("__") && part.length >= 4)
    ) {
      elements.push(
        React.createElement(
          "strong",
          { key: i, className: "font-semibold text-slate-900" },
          parseSafeInline(part.slice(2, -2))
        )
      );
    } else if (
      (part.startsWith("*") && part.endsWith("*") && part.length >= 2) ||
      (part.startsWith("_") && part.endsWith("_") && part.length >= 2)
    ) {
      elements.push(
        React.createElement(
          "em",
          { key: i, className: "italic" },
          parseSafeInline(part.slice(1, -1))
        )
      );
    } else {
      // String text: React automatically escapes HTML entities, making raw script/html inert
      elements.push(part);
    }
  }

  return elements;
}

export function SafeMarkdown({ content, className }: { content: string; className?: string }): ReactNode {
  if (!content) return null;

  const rawLines = content.split("\n");
  const blocks: ReactNode[] = [];
  let currentList: string[] = [];

  function flushList(key: number) {
    if (currentList.length > 0) {
      blocks.push(
        React.createElement(
          "ul",
          { key: `ul-${key}`, className: "my-1.5 list-disc space-y-1 pl-5" },
          currentList.map((item, idx) =>
            React.createElement("li", { key: idx, className: "leading-relaxed" }, parseSafeInline(item))
          )
        )
      );
      currentList = [];
    }
  }

  let lineIdx = 0;
  while (lineIdx < rawLines.length) {
    const line = rawLines[lineIdx];
    const trimmed = line.trim();

    // Check if line is a bullet item (e.g. "- item" or "* item")
    const bulletMatch = /^[*-]\s+(.+)$/.exec(trimmed);
    if (bulletMatch) {
      currentList.push(bulletMatch[1]);
      lineIdx++;
      continue;
    }

    // Flush any pending list
    flushList(lineIdx);

    if (trimmed === "") {
      lineIdx++;
      continue;
    }

    // Paragraph line
    blocks.push(
      React.createElement(
        "p",
        { key: `p-${lineIdx}`, className: "leading-relaxed" },
        parseSafeInline(line)
      )
    );
    lineIdx++;
  }

  flushList(lineIdx);

  return React.createElement("div", { className: `space-y-1.5 ${className ?? ""}` }, blocks);
}
