"use client";

function recurse(n: number): number {
  return recurse(n + 1);
}

export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Tabs</h1>
      <button id="expand" onClick={() => void recurse(0)}>
        Expand all
      </button>
    </main>
  );
}
