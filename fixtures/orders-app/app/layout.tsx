import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Orders",
  description: "A small order workflow",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
