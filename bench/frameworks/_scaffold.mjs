// Generates the 12 real Next.js App Router benchmark target apps. Each app is a
// minimal self-contained project under this directory; `next`/`react` resolve
// from the shared parent node_modules. Run: `node _scaffold.mjs`.
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const PKG = (name) =>
  JSON.stringify(
    { name, private: true, version: "0.0.0", scripts: { dev: "next dev", build: "next build", start: "next start" } },
    null,
    2
  ) + "\n";

const NEXT_CONFIG = `import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fixtures don't need the AI-agent rule files.
  agentRules: false,
  // next/react are hoisted to the shared parent node_modules, so the Turbopack
  // workspace root must be the parent, not this app dir.
  turbopack: { root: path.resolve(process.cwd(), "..") },
};

export default nextConfig;
`;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "react-jsx",
      incremental: true,
      plugins: [{ name: "next" }],
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts", "**/*.mts"],
    exclude: ["node_modules"],
  },
  null,
  2
) + "\n";

const NEXT_ENV = `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

const LAYOUT = `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
`;

// Each case: id, name, archetype, app/page.tsx source, manifest (seeded bugs),
// and any extra files (relative paths under the app dir).
const CASES = [
  {
    id: "01-null-deref",
    name: "Shop — null cart deref (Next.js App Router)",
    archetype: "null-deref",
    page: `"use client";
import { useState } from "react";

export default function Page() {
  const [count, setCount] = useState(0);
  // Cart is fetched async; the fetch is never wired up, so this stays null and
  // the handler over-asserts with ! and crashes at runtime.
  const [cart, setCart] = useState<{ items: number[] } | null>(null);
  void setCart;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Shop</h1>
      <p style={{ color: "#888" }}>Demo storefront · checkout flow</p>
      <div style={{ border: "1px solid #333", borderRadius: 8, padding: 16, maxWidth: 360 }}>
        <h2>Your cart</h2>
        <p id="count">{count} items</p>
        <button id="view-cart" onClick={() => { const n = cart!.items.length; setCount(n); }}>
          View cart
        </button>
      </div>
    </main>
  );
}
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "reading 'items'", trigger: "click #view-cart" },
      ],
    },
  },
  {
    id: "02-hydration-mismatch",
    name: "Dashboard — hydration text mismatch (Next.js App Router)",
    archetype: "hydration-mismatch",
    page: `"use client";

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
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "error", type: "console_error", message: "Hydration failed", trigger: "render" },
      ],
    },
  },
  {
    id: "03-unhandled-rejection",
    name: "Shop — unhandled cart fetch rejection (Next.js App Router)",
    archetype: "async-race",
    page: `"use client";
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
`,
    files: {
      "app/api/cart/route.ts": `export function GET() {
  return new Response(null, { status: 500 });
}
`,
    },
    manifest: {
      seeded: [
        { id: "bug-1", severity: "error", type: "unhandled_rejection", message: "Cart fetch failed", trigger: "mount" },
      ],
    },
  },
  {
    id: "04-type-coercion",
    name: "Pricing — toFixed on a string (Next.js App Router)",
    archetype: "type-coercion",
    page: `"use client";
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
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "toFixed is not a function", trigger: "click #format" },
      ],
    },
  },
  {
    id: "05-array-bounds",
    name: "Feed — off-by-one pagination (Next.js App Router)",
    archetype: "array-bounds",
    page: `"use client";
import { useState } from "react";

const POSTS = [{ name: "a" }, { name: "b" }, { name: "c" }];

export default function Page() {
  const [page, setPage] = useState(0);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Feed</h1>
      <p id="post">Post: {POSTS[page]?.name}</p>
      <button id="next" onClick={() => {
        // off-by-one: page can reach POSTS.length, indexing undefined
        setPage((p) => p + 1);
        void POSTS[page + 1].name;
      }}>
        Next page
      </button>
    </main>
  );
}
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "reading 'name'", trigger: "click #next" },
      ],
    },
  },
  {
    id: "06-route-null",
    name: "Account — null deref after navigation (Next.js App Router)",
    archetype: "route-transition",
    page: `"use client";
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
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "reading 'token'", trigger: "click #go-detail then click #show-token" },
      ],
    },
  },
  {
    id: "07-json-parse",
    name: "Settings — unvalidated JSON.parse (Next.js App Router)",
    archetype: "json-parse",
    page: `"use client";
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
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "is not valid JSON", trigger: "click #parse" },
      ],
    },
  },
  {
    id: "08-stack-overflow",
    name: "Tabs — unbounded recursion (Next.js App Router)",
    archetype: "stack-overflow",
    page: `"use client";

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
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "Maximum call stack size exceeded", trigger: "click #expand" },
      ],
    },
  },
  {
    id: "09-detached-dom",
    name: "List — double-remove (Next.js App Router)",
    archetype: "detached-dom",
    page: `"use client";
import { useRef } from "react";

export default function Page() {
  const itemRef = useRef<HTMLDivElement | null>(null);

  const remove = () => {
    const node = itemRef.current;
    if (node) node.remove();
    // second deref on the now-detached node's parent
    void node!.parentNode!.appendChild;
  };

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>List</h1>
      <div ref={itemRef} id="item" style={{ border: "1px solid #333", padding: 16 }}>
        Item one
      </div>
      <button id="dismiss" onClick={remove}>
        Dismiss
      </button>
    </main>
  );
}
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "reading 'appendChild'", trigger: "click #dismiss" },
      ],
    },
  },
  {
    id: "10-select-null",
    name: "Form — select change deref (Next.js App Router)",
    archetype: "select-change",
    page: `"use client";

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
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "reading 'value'", trigger: "change #region" },
      ],
    },
  },
  {
    id: "11-hover-crash",
    name: "Tooltip — hover deref (Next.js App Router)",
    archetype: "hover",
    page: `"use client";

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
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "reading 'anchor'", trigger: "hover #hover" },
      ],
    },
  },
  {
    id: "12-keypress-crash",
    name: "Search — keydown deref (Next.js App Router)",
    archetype: "keypress",
    page: `"use client";

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
`,
    manifest: {
      seeded: [
        { id: "bug-1", severity: "crash", type: "uncaught_exception", message: "reading 'execute'", trigger: "keypress #search" },
      ],
    },
  },
];

for (const c of CASES) {
  const dir = join(HERE, c.id);
  mkdirSync(join(dir, "app"), { recursive: true });
  const pkgName = "bench-next-" + c.id;
  writeFileSync(join(dir, "package.json"), PKG(pkgName));
  writeFileSync(join(dir, "next.config.ts"), NEXT_CONFIG);
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(dir, "next-env.d.ts"), NEXT_ENV);
  writeFileSync(join(dir, "app", "layout.tsx"), LAYOUT);
  writeFileSync(join(dir, "app", "page.tsx"), c.page);
  for (const [rel, content] of Object.entries(c.files ?? {})) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ id: c.id, name: c.name, archetype: c.archetype, framework: "next-app-router", seeded: c.manifest.seeded }, null, 2) + "\n"
  );
  console.log("wrote", c.id);
}
console.log("done: 12 apps");
