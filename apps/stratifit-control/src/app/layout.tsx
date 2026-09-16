import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stratifit Control",
  description: "Internal Control Room — authorized operators only",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">{children}</body>
    </html>
  );
}
