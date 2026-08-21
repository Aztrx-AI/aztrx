"use client";

import { useState } from "react";

export function CopyButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Clipboard API unavailable (e.g. non-secure context) — fall back.
      const ta = document.createElement("textarea");
      ta.value = command;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy install command"
      className="shrink-0 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-muted transition-colors hover:text-azure hover:border-azure/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-azure/60"
    >
      {copied ? "copied ✓" : "copy"}
    </button>
  );
}
