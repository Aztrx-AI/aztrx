"use client";
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
