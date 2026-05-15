import { NextResponse } from "next/server";
import { checkRpcHealth, listChains } from "@/lib/chains";
import { sendAlert } from "@/lib/alerting";

export async function GET() {
  const chains = listChains();
  const results: Record<number, {
    name: string;
    endpoints: { url: string; status: string; latencyMs: number | null }[];
  }> = {};

  for (const chain of chains) {
    const health = await checkRpcHealth(chain.id);

    // Alert on any down endpoints
    for (const ep of health) {
      if (ep.status === "down") {
        sendAlert("rpc_down", `RPC ${ep.url} (${chain.name}) is down`).catch(() => {});
      }
    }

    results[chain.id] = {
      name: chain.name,
      endpoints: health,
    };
  }

  return NextResponse.json(results);
}

export const dynamic = "force-dynamic";
