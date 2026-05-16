"use client";

import "./globals.css";
import Link from "next/link";
import { useState } from "react";

const sections = [
  {
    label: "CORE",
    items: [
      { href: "/", label: "Dashboard" },
      { href: "/wallets", label: "Wallets" },
      { href: "/collections", label: "Collections" },
      { href: "/mint", label: "Batch Mint" },
      { href: "/jobs", label: "Jobs" },
    ],
  },
  {
    label: "INFRASTRUCTURE",
    items: [
      { href: "/rpc", label: "RPC Health" },
      { href: "/analytics", label: "Analytics" },
      { href: "/safety", label: "Contract Safety" },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { href: "/settings", label: "Settings" },
    ],
  },
];

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-zinc-100 antialiased">
        <div className="flex h-screen">
      {/* Mobile hamburger */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="lg:hidden fixed top-3 left-3 z-50 p-2 bg-zinc-900 border border-zinc-800 rounded text-zinc-400 hover:text-white transition-colors"
      >
        {sidebarOpen ? "✕" : "☰"}
      </button>

      {/* Overlay */}
      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/60 z-30"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ── */}
      <aside
        className={`${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 fixed lg:sticky z-40 w-60 h-screen bg-zinc-950 border-r border-zinc-800 flex flex-col transition-transform overflow-y-auto`}
      >
        {/* Logo area */}
        <div className="px-5 py-5 border-b border-zinc-800/50">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="MintBot" className="w-9 h-9 rounded-lg flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-white font-semibold text-[15px] tracking-tight leading-tight">MintBot</div>
              <div className="text-[10px] text-zinc-600 font-mono uppercase tracking-[0.15em]">
                ACO Automint
              </div>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          {sections.map((section) => (
            <div key={section.label} className="mb-5">
              <div className="px-3 mb-1.5 text-[10px] text-zinc-600 font-mono uppercase tracking-[0.15em] font-medium">
                {section.label}
              </div>
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className="flex items-center px-3 py-2 rounded-md text-[13px] text-zinc-400 hover:text-white hover:bg-zinc-800/70 transition-colors font-medium tracking-wide"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-800/50 space-y-3">
          <div className="text-[10px] text-zinc-600 font-mono uppercase tracking-[0.15em] leading-relaxed">
            v2.3 &middot; Multi-chain
            <br />
            ERC20 &middot; Flashbots &middot; SSE
          </div>
          <a
            href="https://x.com/hammadbtc"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-[10px] text-zinc-500 hover:text-white font-mono uppercase tracking-[0.12em] transition-colors"
          >
            Powered by <span className="text-zinc-400">@Hammadbtc</span>
          </a>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-auto p-5 lg:p-8 pt-14 lg:pt-8 bg-zinc-950">
        {children}
      </main>
        </div>{/* /flex */}
      </body>
    </html>
  );
}
