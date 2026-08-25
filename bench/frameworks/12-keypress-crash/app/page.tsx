"use client";

export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Search</h1>
      <input
        id="search"
        placeholder="Type…"
        onKeyDown={() => {
          const actions = null as unknown as { execute(): void };
          actions.execute();
        }}
      />
    </main>
  );
}
