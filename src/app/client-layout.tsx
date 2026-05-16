"use client";

import Link from "next/link";
import { useState } from "react";

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/wallets", label: "Wallets" },
  { href: "/collections", label: "Collections" },
  { href: "/mint", label: "Batch Mint" },
  { href: "/jobs", label: "Jobs" },
  { href: "/rpc", label: "RPC Health" },
  { href: "/analytics", label: "Analytics" },
  { href: "/safety", label: "Contract Safety" },
  { href: "/settings", label: "Settings" },
];

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
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
        <div className="px-5 py-6 border-b border-zinc-800/50">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-white rounded flex items-center justify-center">
              <span className="text-black font-bold text-xs font-mono">M</span>
            </div>
            <span className="text-white font-semibold text-sm tracking-tight">MintBot</span>
          </div>
          <div className="mt-1 text-[10px] text-zinc-600 font-mono uppercase tracking-widest">
            ACO Automint
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setSidebarOpen(false)}
              className="flex items-center px-3 py-2 rounded-md text-[13px] text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors font-medium tracking-wide"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-800/50">
          <div className="text-[10px] text-zinc-600 font-mono uppercase tracking-widest leading-relaxed">
            v2.3 · Multi-chain
            <br />
            ERC20 · Flashbots
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-auto p-5 lg:p-8 pt-14 lg:pt-8 bg-zinc-950">
        {children}
      </main>
    </div>
  );
}
