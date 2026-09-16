import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stratifit Media",
  description: "Films, series, music, and AI creators — the Stratifit audience platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        <header className="border-b border-gray-200">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
            <Link href="/" className="text-lg font-bold">
              Stratifit
            </Link>
            <Link href="/discover" className="text-sm text-gray-600 hover:text-gray-900">
              Discover
            </Link>
            <Link href="/creators" className="text-sm text-gray-600 hover:text-gray-900">
              Creators
            </Link>
          </nav>
        </header>
        {children}
        <footer className="border-t border-gray-200">
          <div className="mx-auto max-w-6xl px-6 py-8 text-sm text-gray-500">
            Stratifit Media — audience platform. Content is produced and published by
            Stratifit Control.
          </div>
        </footer>
      </body>
    </html>
  );
}
