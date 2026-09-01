"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import "./globals.css";

const nav = [
  { href: "/", label: "Mints", icon: "leaf" },
  { href: "/studio", label: "Studio", icon: "studio" },
  { href: "/wallets", label: "Wallets", icon: "wallet" },
  { href: "/disperse", label: "Disperse", icon: "nodes" },
];

function Icon({ name, size = 24 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "leaf") return <svg {...common}><path d="M20 4c-8 0-14 3.5-14 10 0 3 2 5 5 5 6.5 0 9-7 9-15Z"/><path d="M4 21c2-5 6-8 11-11"/></svg>;
  if (name === "wallet") return <svg {...common}><path d="M4 6.5h15a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6.5A2.5 2.5 0 0 1 4.5 4H18"/><path d="M2 9h19M16 14h2"/></svg>;
  if (name === "studio") return <svg {...common}><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h5M8 16h8"/><circle cx="17" cy="12" r="1" fill="currentColor" stroke="none"/></svg>;
  if (name === "nodes") return <svg {...common}><circle cx="12" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="12" cy="19" r="2"/><path d="m10.5 6.5-4 4m7-4 4 4m-11 3 4 4m7-4-4 4"/></svg>;
  return null;
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [dark, setDark] = useState(false);
  const [engine, setEngine] = useState<{ ready: boolean; liveTransactionsEnabled: boolean } | null>(null);
  useEffect(() => {
    const saved = localStorage.getItem("mintbot-theme");
    const next = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = next ? "dark" : "light";
    queueMicrotask(() => setDark(next));
  }, []);
  useEffect(() => {
    let mounted = true;
    const check = () => fetch("/api/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((status) => { if (mounted) setEngine(status); })
      .catch(() => { if (mounted) setEngine({ ready: false, liveTransactionsEnabled: false }); });
    void check();
    const interval = setInterval(check, 15_000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);
  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    localStorage.setItem("mintbot-theme", next ? "dark" : "light");
  };

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <div className="app-shell">
          <header className="topbar">
            <Link href="/" className="brand"><span className="brand-mark"><Icon name="leaf" size={22}/></span><span>MintBot</span></Link>
            <div className="top-actions">
              <span className="status-dot"><i style={{ background: engine?.ready ? undefined : "var(--danger)" }}/>{engine === null ? "Checking engine…" : engine.ready ? engine.liveTransactionsEnabled ? "Engine live" : "Ready · broadcast locked" : "Engine unavailable"}</span>
              <button className="icon-button" onClick={toggleTheme} aria-label="Toggle theme">{dark ? "☀" : "☾"}</button>
            </div>
          </header>
          <div className="notice">Mint didn&apos;t work? Found a bug? <a href="https://x.com/hammadbtc" target="_blank" rel="noreferrer noopener">Report an issue</a></div>
          <main className="page-wrap">{children}</main>
          <nav className="bottom-nav">
            {nav.map((item) => {
              const active = pathname === item.href;
              return <Link key={item.href} href={item.href} className={active ? "active" : ""}><Icon name={item.icon}/><span>{item.label}</span></Link>;
            })}
          </nav>
        </div>
      </body>
    </html>
  );
}
