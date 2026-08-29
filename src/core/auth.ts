/**
 * F-auth — auto-login. Locates a login form and drives it with the user's
 * credentials, so the rest of the run (and its repros) exercise the app
 * *authenticated*. Best-effort by design: a login that can't be found or
 * doesn't complete is reported, never fatal — the run continues unauth.
 *
 * The password input is the reliable signal for a login form; the email/username
 * field and submit button are resolved within its nearest `<form>` (or the page
 * body when the app doesn't use a `<form>` element).
 */

import type { Locator, Page } from "playwright";

export interface LoginOptions {
  email: string;
  password: string;
  /** Optional explicit login page URL; otherwise the current page is used. */
  loginUrl?: string;
}

export interface LoginResult {
  ok: boolean;
  reason?: string;
}

export interface LoginForm {
  email: Locator;
  password: Locator;
  submit: Locator | null;
}

/** Locate a login form on the current page, or `null` if none is present. */
export async function findLoginForm(page: Page): Promise<LoginForm | null> {
  const password = page.locator('input[type="password"]').first();
  if ((await password.count()) === 0) return null;

  const form = password.locator("xpath=ancestor::form[1]");
  const scope: Locator = (await form.count()) > 0 ? form : page.locator("body");

  const emailCandidates: Locator[] = [
    scope.locator('input[type="email"]'),
    scope.locator('input[autocomplete="username"]'),
    scope.locator('input[name*="email" i]'),
    scope.locator('input[name*="user" i]'),
    scope.locator('input[name*="login" i]'),
    scope.locator('input[type="text"]'),
  ];
  let email: Locator | null = null;
  for (const c of emailCandidates) {
    if ((await c.count()) > 0) {
      email = c.first();
      break;
    }
  }
  if (!email) return null;

  const submitCandidates: Locator[] = [
    scope.locator('button[type="submit"]'),
    scope.locator('input[type="submit"]'),
  ];
  let submit: Locator | null = null;
  for (const c of submitCandidates) {
    if ((await c.count()) > 0) {
      submit = c.first();
      break;
    }
  }

  return { email, password, submit };
}

/**
 * Drive the login form. Returns whether it appeared to complete: the password
 * field vanished, or the URL changed. Never throws — every step degrades.
 */
export async function establishLogin(page: Page, opts: LoginOptions): Promise<LoginResult> {
  if (opts.loginUrl) {
    await page.goto(opts.loginUrl, { waitUntil: "load", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  const form = await findLoginForm(page);
  if (!form) return { ok: false, reason: "no login form detected" };

  await form.email.fill(opts.email).catch(() => {});
  await form.password.fill(opts.password).catch(() => {});
  const urlBefore = page.url();

  if (form.submit) {
    await form.submit.click({ timeout: 3000 }).catch(() => {});
  } else {
    await form.password.press("Enter").catch(() => {});
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1500);

  const stillHasPassword = (await page.locator('input[type="password"]').count()) > 0;
  const urlChanged = page.url() !== urlBefore;
  if (!stillHasPassword || urlChanged) return { ok: true };
  return { ok: false, reason: "login did not appear to complete" };
}
