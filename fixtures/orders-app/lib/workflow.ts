export type OrderStatus = "pending" | "confirmed" | "completed" | "cancelled";
export type OrderAction = "confirm" | "complete" | "cancel";

/**
 * Which action moves an order out of which status. A status with no entry for
 * an action refuses it.
 */
export const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderAction, OrderStatus>>> = {
  pending: { confirm: "confirmed", cancel: "cancelled" },
  confirmed: { complete: "completed", cancel: "cancelled" },
  completed: {},
  cancelled: {},
};
