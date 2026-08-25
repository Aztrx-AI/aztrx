"use client";

export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Tooltip</h1>
      <button
        id="hover"
        onMouseEnter={() => {
          const tip = null as unknown as { anchor: { x: number } };
          void tip.anchor.x;
        }}
      >
        Hover me
      </button>
    </main>
  );
}
