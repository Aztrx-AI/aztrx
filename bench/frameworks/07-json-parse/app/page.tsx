"use client";
import { useState } from "react";

export default function Page() {
  const [result, setResult] = useState("");
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Settings</h1>
      <p id="result">{result}</p>
      <button id="parse" onClick={() => {
        setResult(JSON.parse("oops"));
      }}>
        Parse
      </button>
    </main>
  );
}
