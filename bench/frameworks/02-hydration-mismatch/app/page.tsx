"use client";

export default function Page() {
  // Rendered on the server and again on the client with different values, so
  // React's hydration check flags the text mismatch.
  const token = Math.random();

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Dashboard</h1>
      <p id="token">session token: {token}</p>
      <button id="refresh">Refresh</button>
    </main>
  );
}
