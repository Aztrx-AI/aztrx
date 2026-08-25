"use server";

export async function placeOrder() {
  // Server Action that always fails. The client invokes it in a click handler
  // and lets the rejection go unhandled — the boundary Aztrx must catch as an
  // "error" (escalated unhandled rejection), not a "warning".
  throw new Error("Order submit failed: quota exceeded");
}
