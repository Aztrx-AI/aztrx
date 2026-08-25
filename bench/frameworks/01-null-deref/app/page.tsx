"use client";
import { useState } from "react";

export default function Page() {
  const [count, setCount] = useState(0);
  // Cart is fetched async; the fetch is never wired up, so this stays null and
  // the handler over-asserts with ! and crashes at runtime.
  const [cart, setCart] = useState<{ items: number[] } | null>(null);
  void setCart;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Shop</h1>
      <p style={{ color: "#888" }}>Demo storefront · checkout flow</p>
      <div style={{ border: "1px solid #333", borderRadius: 8, padding: 16, maxWidth: 360 }}>
        <h2>Your cart</h2>
        <p id="count">{count} items</p>
        <button id="view-cart" onClick={() => { const n = cart!.items.length; setCount(n); }}>
          View cart
        </button>
      </div>
    </main>
  );
}
