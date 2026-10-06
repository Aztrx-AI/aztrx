// Order lifecycle: which action may move an order out of which state.
export const orderMachine = {
  pending:   { pay: "paid", cancel: "cancelled" },
  paid:      { fulfill: "fulfilled", cancel: "cancelled" },
  cancelled: {},
  fulfilled: {},
};
