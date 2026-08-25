"use client";

export default function Page() {
  // Hydration mismatch: server and client render different values. Aztrx must
  // TRIAGE this as boundary noise (tracked, never surfaced as a finding) while
  // still catching the real interaction bug below.
  const token = Math.random();

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Dashboard</h1>
      <p id="token">session token: {token}</p>
      <button id="refresh">Refresh</button>

      <hr style={{ margin: "16px 0" }} />

      <h2>Profile</h2>
      <button
        id="show-profile"
        onClick={() => {
          // profile stays null until loaded; the handler over-asserts.
          const profile = null as unknown as { email: string };
          void profile.email;
        }}
      >
        Show profile
      </button>
    </main>
  );
}
