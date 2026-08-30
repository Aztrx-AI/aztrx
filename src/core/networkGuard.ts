import type { Page } from "playwright";

export interface NetworkGuardOptions {
  allowHosts: Set<string>;
  onBlock?: (url: string) => void;
}

/**
 * F6 — deny-by-default network guard (PRD §6.2). Aborts every request whose
 * host isn't allow-listed, so a fuzz/replay pass can't reach payment, delete,
 * or analytics endpoints. Loopback is always allowed (this is a local tool).
 */
export async function attachNetworkGuard(page: Page, opts: NetworkGuardOptions): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      await route.abort("blockedbyclient");
      return;
    }

    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      await route.continue();
      return;
    }
    for (const h of opts.allowHosts) {
      if (host === h || host.endsWith("." + h)) {
        await route.continue();
        return;
      }
    }
    opts.onBlock?.(url);
    await route.abort("blockedbyclient");
  });
}

/** Builds the allow-list: target origin + each `--allow-host`. */
export function allowHostsFrom(url: string, extra: string[]): Set<string> {
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(url).hostname.toLowerCase());
  } catch {
    // ignore malformed target
  }
  for (const h of extra) {
    try {
      hosts.add(new URL(h.includes("://") ? h : `http://${h}`).hostname.toLowerCase());
    } catch {
      // ignore malformed host
    }
  }
  return hosts;
}
