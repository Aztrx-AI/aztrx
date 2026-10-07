import { orderAction } from "./actions";
import { currentOrder } from "@/lib/orders";

export default async function Home() {
  const order = await currentOrder();

  return (
    <main style={{ padding: 40, maxWidth: 480 }}>
      <h1>Your order</h1>
      <p>
        Status: <strong>{order.status}</strong>
      </p>
      <form action={orderAction} style={{ display: "flex", gap: 8 }}>
        <button type="submit" name="action" value="confirm">
          Confirm
        </button>
        <button type="submit" name="action" value="complete">
          Complete
        </button>
        <button type="submit" name="action" value="cancel">
          Cancel
        </button>
      </form>
    </main>
  );
}
