/**
 * Business-risk language — what the developer actually hears.
 *
 * "IDOR in /api/v1/files" tells a vibe-coder nothing. "A paid file can be
 * downloaded for free by opening a link directly" tells them exactly what
 * they stand to lose. Each finding class gets a deterministic one-sentence
 * business risk (en/ru), attached to the finding and printed in the audit
 * report. No LLM, no key — templates keyed on the finding's own evidence.
 */

import type { Finding } from "./types.js";

type Lang = "en" | "ru";

interface Templates {
  keyStolen: (name: string) => string;
  roleForged: (evidence: string) => string;
  paywallFree: (route: string) => string;
  serverDown: (url: string) => string;
  pageCrash: () => string;
  generic: (severity: string) => string;
}

const T: Record<Lang, Templates> = {
  en: {
    keyStolen: (name) =>
      `Anyone can steal your ${name} straight out of the page's HTML — spend with it, read your data, and send you the bill.`,
    roleForged: (evidence) =>
      `Anyone can forge a token and the app believes it — "${evidence}" opened without permission. Your roles are decoration.`,
    paywallFree: (route) =>
      `The paid content on ${route} renders without payment or login — revenue walking out the door.`,
    serverDown: (url) =>
      `One hostile request to ${url} takes the server down — your uptime is one curl away from gone.`,
    pageCrash: () =>
      `This interaction crashes the page for every user who tries it — a dead button is a dead funnel.`,
    generic: (severity) => `Something is ${severity}-level wrong here — fix it before a user finds it first.`,
  },
  ru: {
    keyStolen: (name) =>
      `Любой может украсть ${name} прямо из HTML страницы — тратить с него деньги, читать твои данные и выставлять счёт тебе.`,
    roleForged: (evidence) =>
      `Кто угодно может подделать токен, и приложение поверит — «${evidence}» открылось без разрешения. Твои роли — декорация.`,
    paywallFree: (route) =>
      `Платный контент на ${route} открывается без оплаты и без входа — доход уходит сквозь дыру.`,
    serverDown: (url) =>
      `Один враждебный запрос к ${url} роняет сервер — твой аптайм в одном curl от нуля.`,
    pageCrash: () =>
      `Это действие роняет страницу у каждого, кто его пробует — мёртвая кнопка это мёртвая воронка.`,
    generic: (severity) => `Здесь что-то не так уровня «${severity}» — почини до того, как это найдёт пользователь.`,
  },
};

const KEY_NAME = /Secret exposed in page source: ([A-Za-z ]+?) on/;
const FORGED_EVIDENCE = /opened "([^"]+)"/;
const PAYWALL_ROUTE = /Paywall bypassed: ([^ ]+) renders/;
const NET_URL = /(https?:\/\/[^\s]+)/;

/** Attach a one-sentence business risk to a finding, in the user's language. */
export function businessRiskOf(finding: Finding, lang: string = "en"): string {
  const t = T[lang === "ru" ? "ru" : "en"];

  if (finding.type === "secret_leak") {
    const keyName = KEY_NAME.exec(finding.rawMessage)?.[1];
    if (keyName) return t.keyStolen(keyName.trim().toLowerCase());
    const forged = FORGED_EVIDENCE.exec(finding.rawMessage)?.[1];
    if (forged) return t.roleForged(forged);
    const route = PAYWALL_ROUTE.exec(finding.rawMessage)?.[1];
    if (route) return t.paywallFree(route);
  }
  if (finding.type === "network_5xx" || finding.type === "network_timeout") {
    const url = NET_URL.exec(finding.rawMessage)?.[1];
    return t.serverDown(url ?? "your API");
  }
  if (finding.type === "uncaught_exception" || finding.type === "unhandled_rejection") {
    return t.pageCrash();
  }
  return t.generic(finding.severity);
}

/** Annotate every finding in place (skips findings that already have one). */
export function annotateBusinessRisks(findings: Finding[], lang: string = "en"): Finding[] {
  for (const f of findings) {
    if (!f.businessRisk) f.businessRisk = businessRiskOf(f, lang);
  }
  return findings;
}
