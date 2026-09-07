/**
 * F14 — the per-finding "diagnosis headline": one sentence that says *why* a
 * crash happened and *what to change*, rendered inline with every crash/error
 * finding (terminal + report.html) on the free, no-key tier.
 *
 * It is deliberately deterministic — keyed on the V8 message shape — so it
 * needs no network round-trip and can never fail the run. The suggested fix
 * mirrors what `--fix` actually applies (optional chaining for null/undefined
 * derefs), so the headline never over-promises a fix it can't deliver.
 */

import type { Finding } from "./types.js";

export type Lang = "en" | "ru";

function normalizeLang(lang?: string): Lang {
  return lang === "ru" ? "ru" : "en";
}

interface Phrases {
  deref: (nullish: "null" | "undefined", prop: string) => string;
  toFixed: string;
  notAFunction: string;
  notDefined: string;
  notConstructor: string;
  notIterable: string;
  jsonParse: string;
  recursion: string;
  server5xx: string;
  timeout: string;
  unhandledRejection: string;
  uncaught: string;
}

const PHRASES: Record<Lang, Phrases> = {
  en: {
    deref: (n, p) => `the value before \`.${p}\` is ${n} — guard with \`?.\` or a default`,
    toFixed: `you're calling \`.toFixed()\` on a string, not a number — wrap it in \`Number()\` first`,
    notAFunction: `a method was called on a value of the wrong type — check it's the object you expect`,
    notDefined: `a variable is referenced before it's defined — check the name, scope, or import`,
    notConstructor: `\`new\` was called on a non-constructor — check the export/import`,
    notIterable: `you're iterating (spread/for..of) over a non-iterable — coerce it to an array first`,
    jsonParse: `\`JSON.parse\` got malformed input — wrap in try/catch or validate the payload first`,
    recursion: `unbounded recursion — add a base case or guard the recursive call`,
    server5xx: `the server returned 5xx on this route — read the server stack and fix the handler`,
    timeout: `the request hung past the timeout — check for a slow/deadlocked handler or a missing \`await\``,
    unhandledRejection: `a promise rejected with nothing catching it — add \`.catch()\` or \`await\` inside try/catch`,
    uncaught: `an uncaught error escaped — wrap in try/catch or guard the input`,
  },
  ru: {
    deref: (n, p) => `значение перед \`.${p}\` равно ${n} — обезопась через \`?.\` или значение по умолчанию`,
    toFixed: `ты зовёшь \`.toFixed()\` на строке, а не на числе — оберни в \`Number()\` сначала`,
    notAFunction: `метод вызван на значении неверного типа — проверь, что это тот объект, который ты ждёшь`,
    notDefined: `переменная используется до определения — проверь имя, область видимости или импорт`,
    notConstructor: `\`new\` вызван на не-конструкторе — проверь экспорт/импорт`,
    notIterable: `ты итерируешь (spread/for..of) не-итерируемое — сначала приведи к массиву`,
    jsonParse: `\`JSON.parse\` получил битый ввод — оберни в try/catch или сначала провалидируй`,
    recursion: `бесконечная рекурсия — добавь базовый случай или ограничь рекурсивный вызов`,
    server5xx: `сервер вернул 5xx на этом маршруте — смотри серверный стек и чини обработчик`,
    timeout: `запрос завис дольше таймаута — проверь на медленный/мёртвый обработчик или пропущенный \`await\``,
    unhandledRejection: `промис отклонился, а ловить некому — добавь \`.catch()\` или \`await\` в try/catch`,
    uncaught: `непойманная ошибка вырвалась — оберни в try/catch или проверь входные данные`,
  },
};

/** Match the two V8 null/undefined-deref shapes (modern and legacy) and return
 * the normalized nullish value + the property being read. */
function matchDeref(line: string): { nullish: "null" | "undefined"; prop: string } | null {
  let m = /cannot read properties of (undefined|null) \(reading '([^']*)'\)/i.exec(line);
  if (m) return { nullish: m[1].toLowerCase() as "null" | "undefined", prop: m[2] };
  m = /cannot read property '([^']*)' of (undefined|null)/i.exec(line);
  if (m) return { nullish: m[2].toLowerCase() as "null" | "undefined", prop: m[1] };
  return null;
}

/**
 * One-line diagnosis for a finding, or "" when there is nothing actionable to
 * say (noise, or a shape we don't recognize). Crash/error findings only — the
 * headline is advice, and triaged-away noise deserves none.
 */
export function diagnoseFinding(f: Finding, lang?: string): string {
  if (f.severity !== "crash" && f.severity !== "error") return "";
  const p = PHRASES[normalizeLang(lang)];
  const line = (f.rawMessage || "").split("\n")[0].trim();

  const deref = matchDeref(line);
  if (deref) return p.deref(deref.nullish, deref.prop);

  if (/\.toFixed\s*is not a function/i.test(line)) return p.toFixed;
  if (/\bis not a function\b/i.test(line)) return p.notAFunction;
  if (/\bis not defined\b/i.test(line)) return p.notDefined;
  if (/\bis not a constructor\b/i.test(line)) return p.notConstructor;
  if (/\bis not iterable\b/i.test(line)) return p.notIterable;
  if (/not valid json|unexpected token|unexpected end of json|\bjson\.parse\b/i.test(line)) return p.jsonParse;
  if (/maximum call stack size exceeded/i.test(line)) return p.recursion;

  if (f.type === "network_5xx") return p.server5xx;
  if (f.type === "network_timeout") return p.timeout;
  if (f.type === "unhandled_rejection") return p.unhandledRejection;
  if (f.type === "uncaught_exception") return p.uncaught;

  return "";
}
