import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

export const metadata: Metadata = {
  title: "MintBot — ACO AutoMint",
  description: "Multi-chain NFT auto-mint service with Flashbots, dry-run, and RPC health monitoring",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen">
        <div className="flex h-screen">
          {/* Sidebar */}
          <aside className="w-64 bg-zinc-900 border-r border-zinc-800 p-4 flex flex-col gap-1">
            <h1 className="text-lg font-bold text-emerald-400 mb-4">🦾 MintBot</h1>

            <SectionLabel>Core</SectionLabel>
            <NavLink href="/">📊 Dashboard</NavLink>
            <NavLink href="/wallets">👛 Wallets</NavLink>
            <NavLink href="/collections">🎨 Collections</NavLink>
            <NavLink href="/mint">🚀 Batch Mint</NavLink>
            <NavLink href="/jobs">⚡ Jobs</NavLink>

            <SectionLabel>Infrastructure</SectionLabel>
            <NavLink href="/rpc">🔌 RPC Health</NavLink>
            <NavLink href="/analytics">📈 Analytics</NavLink>

            <SectionLabel>System</SectionLabel>
            <NavLink href="/settings">⚙️ Settings</NavLink>

            <div className="mt-auto pt-4 border-t border-zinc-800 text-xs text-zinc-500 space-y-1">
              <div>ACO AutoMint v2.1</div>
              <div>FCFS • Scheduled • Analytics</div>
            </div>
          </aside>

          {/* Main */}
          <main className="flex-1 overflow-auto p-6">{children}</main>
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

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
    >
      {children}
    </Link>
  );
}
