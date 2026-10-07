import { cookies } from "next/headers";
import { TRANSITIONS, type OrderAction, type OrderStatus } from "./workflow";

interface Order {
  id: string;
  status: OrderStatus;
}

// One order per browser session, kept in memory. Stored on globalThis so the
// dev server's module reloads don't wipe it.
const g = globalThis as unknown as { __orders?: Map<string, Order> };
const db = (g.__orders ??= new Map<string, Order>());

export async function currentOrder(): Promise<{ status: OrderStatus }> {
  const id = (await cookies()).get("order")?.value;
  return (id && db.get(id)) || { status: "pending" };
}

export async function applyAction(action: OrderAction): Promise<{ ok: boolean }> {
  const jar = await cookies();
  let order = db.get(jar.get("order")?.value ?? "");
  if (!order) {
    order = { id: crypto.randomUUID(), status: "pending" };
    db.set(order.id, order);
    jar.set("order", order.id, { httpOnly: true, path: "/" });
  }

  const next = TRANSITIONS[order.status][action];
  if (!next) return { ok: false };
  order.status = next;
  return { ok: true };
}
