/**
 * Intent parsing — what is the user afraid of?
 *
 * "Проверь безопасность оплаты" is not a scan request, it's a fear: someone
 * gets the paid stuff for free, or the card flow breaks. This module maps the
 * fear to a focused role plan — which of the swarm's agents run, and why — so
 * the swarm answers the actual question instead of walking everything.
 *
 * Deterministic keyword tables (en + ru), free and instant, exactly like the
 * profile scout. No LLM, no key.
 */

import type { Role } from "./roles.js";
import { resolveRoles } from "./roles.js";

export interface IntentPlan {
  /** The theme the intent resolved to: payment | auth | data | availability | files | general. */
  theme: string;
  /** Role ids this intent runs. */
  roles: string[];
  /** One human line describing the plan — printed before the swarm launches. */
  hint: string;
}

interface IntentRule {
  theme: string;
  keywords: RegExp;
  roles: string[];
  hint: string;
}

const RULES: IntentRule[] = [
  {
    theme: "payment",
    keywords: /оплат|плат(еж|ёж)|pay|checkout|карт|stripe|billing|подпис|пейвол|paywall|premium|премиум|тариф|price|цен|счёт|счет/i,
    roles: ["paywall-bypass", "token-tamper", "hostile", "race-hunter", "http-raider", "ssr-leak", "session-killer"],
    hint: "Проверяю платёжный контур: бесплатный доступ к платному, подмена ролей, двойные списания, падение на оплате.",
  },
  {
    theme: "auth",
    keywords: /логин|парол|auth|login|sign ?in|sign ?up|token|jwt|токен|аккаунт|сесси|session|рол(ь|и)|role|admin|админ|поддел|взлом|хак/i,
    roles: ["token-tamper", "hostile", "ssr-leak", "http-raider", "a11y"],
    hint: "Проверяю вход и роли: подделка токенов, угадывание доступов, утечки ключей из HTML.",
  },
  {
    theme: "data",
    keywords: /данн|утечк|leak|privacy|pii|персон|конфиденц|secret|ключ|api[ -]?key|секрет/i,
    roles: ["ssr-leak", "observer", "http-raider", "token-tamper"],
    hint: "Проверяю утечки: секреты в HTML, лишние данные в ответах API, чужие данные по прямым ссылкам.",
  },
  {
    theme: "availability",
    keywords: /паден|упад|краш|crash|сервер|downtime|висит|тормоз|ломает|500|ошибк/i,
    roles: ["hostile", "session-killer", "race-hunter", "slow-net", "http-raider"],
    hint: "Проверяю живучесть: чем можно уронить сервер или страницу — и как легко.",
  },
  {
    theme: "files",
    keywords: /файл|скач|download|upload|загруз|attach|file|документ|фото|картин/i,
    roles: ["paywall-bypass", "ssr-leak", "hostile", "http-raider"],
    hint: "Проверяю файлы: бесплатное скачивание платного, чужие файлы по прямой ссылке, кривые загрузки.",
  },
];

/** Resolve free text into a focused role plan. Unknown/empty intents run the
 * full catalog — when the user doesn't name a fear, the whole team answers. */
export function parseIntent(text: string | undefined, roles: Role[] = resolveRoles(undefined)): IntentPlan {
  const input = (text ?? "").trim();
  if (!input) {
    return {
      theme: "general",
      roles: roles.map((r) => r.id),
      hint: "Запускаю весь рой — когда страха не назвали, проверяем всё.",
    };
  }

  const rule = RULES.find((r) => r.keywords.test(input));
  if (!rule) {
    return {
      theme: "general",
      roles: roles.map((r) => r.id),
      hint: `Не распознал конкретный страх в «${input.slice(0, 60)}» — запускаю весь рой.`,
    };
  }
  return { theme: rule.theme, roles: rule.roles, hint: rule.hint };
}

/** Role ids an intent plan names but the catalog doesn't have (for CLI validation). */
export function unknownIntentRoles(plan: IntentPlan, known: Set<string>): string[] {
  return plan.roles.filter((id) => !known.has(id));
}
