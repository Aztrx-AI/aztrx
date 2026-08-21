import type { ElementHandle, Page } from "playwright";
import type { RecordedAction } from "./types.js";

type AnyElement = SVGElement | HTMLElement;

/**
 * F2 — ring buffer of the last 25 actions. The Repro Minimizer (F7) later
 * shrinks this history; for now it's the action context attached to findings.
 */
export class ActionRecorder {
  private buffer: RecordedAction[] = [];
  readonly capacity = 25;

  record(action: RecordedAction): void {
    this.buffer.push(action);
    if (this.buffer.length > this.capacity) this.buffer.shift();
  }

  snapshot(): RecordedAction[] {
    return [...this.buffer];
  }
}

/** Selector cascade, most-reliable first: data-testid → text → css path. */
export async function selectorCascade(page: Page, handle: ElementHandle<AnyElement>): Promise<string[]> {
  const out: string[] = [];

  const testId = await handle.evaluate((el) => {
    const t = el.getAttribute("data-testid");
    return t ? `[data-testid="${t}"]` : null;
  });
  if (testId) out.push(testId);

  const text = await handle.evaluate((el) => {
    const t = (el as HTMLElement).innerText?.trim().replace(/\s+/g, " ").slice(0, 60);
    return t ?? "";
  });
  if (text) out.push(`text=${JSON.stringify(text)}`);

  const css = await cssPathOf(handle);
  if (css) out.push(css);

  return out;
}

async function cssPathOf(handle: ElementHandle<AnyElement>): Promise<string | null> {
  return handle.evaluate((el) => {
    function cssPath(node: Element): string {
      if (node.id) return `#${CSS.escape(node.id)}`;
      const parts: string[] = [];
      let current: Element | null = node;
      while (current !== null && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        if (current.id) {
          parts.unshift(`#${CSS.escape(current.id)}`);
          break;
        }
        const parentElement: Element | null = current.parentElement;
        if (parentElement !== null) {
          const siblings = Array.from(parentElement.children).filter((child) => child.tagName === tag);
          if (siblings.length > 1) {
            parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
            current = parentElement;
            continue;
          }
        }
        parts.unshift(tag);
        current = parentElement;
      }
      return parts.join(" > ");
    }
    try {
      return cssPath(el);
    } catch {
      return null;
    }
  });
}
