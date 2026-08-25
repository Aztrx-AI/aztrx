"use client";
import { useState } from "react";

export default function Page() {
  const [total, setTotal] = useState("$0.00");
  const [price, setPrice] = useState("12.99");
  void setPrice;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Pricing</h1>
      <p id="total">{total}</p>
      <button id="format" onClick={() => {
        const n = (price as unknown as number).toFixed(2);
        setTotal("$" + n);
      }}>
        Format total
      </button>
    </main>
  );
}
