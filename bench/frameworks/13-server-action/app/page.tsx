"use client";
import { useState } from "react";
import { placeOrder } from "./actions";

export default function Page() {
  const [status, setStatus] = useState("idle");

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Checkout</h1>
      <p style={{ color: "#888" }}>Server Action demo · submit order</p>
      <p id="status">{status}</p>
      <button
        id="place-order"
        onClick={async () => {
          await placeOrder(); // rejects — no catch, unhandled
          setStatus("placed");
        }}
      >
        Place order
      </button>
    </main>
  );
}
