"use client";
import { useEffect } from "react";

export default function Page() {
  useEffect(() => {
    async function load() {
      const r = await fetch("/api/cart");
      if (!r.ok) throw new Error("Cart fetch failed (500)");
    }
    // no .catch — the rejection is unhandled
    load();
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Shop</h1>
      <p id="status">loading cart…</p>
    </main>
  );
}
