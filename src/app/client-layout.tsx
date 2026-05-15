"use client";

import "./globals.css";
import Link from "next/link";
import { useState } from "react";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen">
        {/* Mobile hamburger */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="lg:hidden fixed top-3 left-3 z-50 p-2 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-400"
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

        <div className="flex h-screen">
          <aside
            className={`${
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            } lg:translate-x-0 fixed lg:relative z-40 w-64 h-screen bg-zinc-900 border-r border-zinc-800 p-4 flex flex-col gap-1 transition-transform overflow-y-auto`}
          >
            <h1 className="text-lg font-bold text-emerald-400 mb-4">🦾 MintBot</h1>

            <SectionLabel>Core</SectionLabel>
            <NavLink href="/" onClick={() => setSidebarOpen(false)}>📊 Dashboard</NavLink>
            <NavLink href="/wallets" onClick={() => setSidebarOpen(false)}>👛 Wallets</NavLink>
            <NavLink href="/collections" onClick={() => setSidebarOpen(false)}>🎨 Collections</NavLink>
            <NavLink href="/mint" onClick={() => setSidebarOpen(false)}>🚀 Batch Mint</NavLink>
            <NavLink href="/jobs" onClick={() => setSidebarOpen(false)}>⚡ Jobs</NavLink>

            <SectionLabel>Infrastructure</SectionLabel>
            <NavLink href="/rpc" onClick={() => setSidebarOpen(false)}>🔌 RPC Health</NavLink>
            <NavLink href="/analytics" onClick={() => setSidebarOpen(false)}>📈 Analytics</NavLink>
            <NavLink href="/safety" onClick={() => setSidebarOpen(false)}>🛡️ Contract Safety</NavLink>

            <SectionLabel>System</SectionLabel>
            <NavLink href="/settings" onClick={() => setSidebarOpen(false)}>⚙️ Settings</NavLink>

            <div className="mt-auto pt-4 border-t border-zinc-800 text-xs text-zinc-500 space-y-1">
              <div>ACO AutoMint v2.2</div>
              <div>ERC20 • Multi-worker • SSE</div>
            </div>
          </aside>

          <main className="flex-1 overflow-auto p-4 lg:p-6 pt-14 lg:pt-6">{children}</main>
        </div>
      </body>
    </html>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mt-3 mb-1 px-1">
      {children}
    </div>
  );
}

function NavLink({ href, children, onClick }: { href: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
    >
      {children}
    </Link>
  );
}
