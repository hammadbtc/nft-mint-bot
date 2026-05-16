import type { Metadata } from "next";
import ClientLayout from "./client-layout";

export const metadata: Metadata = {
  title: "MintBot — ACO AutoMint",
  description: "Multi-chain NFT auto-mint with Flashbots, FCFS, ERC20, and multi-worker",
  icons: { icon: "/logo.png", apple: "/logo.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <ClientLayout>{children}</ClientLayout>;
}
