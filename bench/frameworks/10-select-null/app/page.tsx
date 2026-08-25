"use client";

export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Form</h1>
      <select
        id="region"
        defaultValue=""
        onChange={(e) => {
          const meta = null as unknown as { value: string };
          void meta.value;
          void e.target.value;
        }}
      >
        <option value="">Choose…</option>
        <option value="us">US</option>
        <option value="eu">EU</option>
      </select>
    </main>
  );
}
