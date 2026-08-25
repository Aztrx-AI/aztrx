"use client";
import { useState } from "react";

export default function Page() {
  const [view, setView] = useState<"home" | "detail">("home");

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Account</h1>
      {view === "home" ? (
        <button id="go-detail" onClick={() => setView("detail")}>
          Go to detail
        </button>
      ) : (
        <button
          id="show-token"
          onClick={() => {
            // session stays null until login; the handler derefs it anyway
            const session = null as unknown as { token: string };
            void session.token;
          }}
        >
          Show token
        </button>
      )}
    </main>
  );
}
