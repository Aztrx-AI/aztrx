"use client";
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
