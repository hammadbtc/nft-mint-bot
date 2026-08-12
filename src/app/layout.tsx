import type { Metadata } from "next";
import ClientLayout from "./client-layout";

export const metadata: Metadata = {
  title: "MintBot — effortless multi-wallet minting",
  description: "Find, schedule and track NFT mints across your wallets.",
  icons: { icon: "/logo.png", apple: "/logo.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <ClientLayout>{children}</ClientLayout>;
}
