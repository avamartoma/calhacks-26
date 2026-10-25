import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "opencloud share",
  description: "Open a shared opencloud project.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
