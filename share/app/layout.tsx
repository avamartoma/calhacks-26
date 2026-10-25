import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Iteration1 share",
  description: "Open a shared Iteration1 project.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
