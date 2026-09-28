import "server-only";

import { headers } from "next/headers";

/**
 * The address phones should use to reach this app, for the join QR code. `make lan` sets
 * PUBLIC_ORIGIN to the laptop's Wi-Fi address; deployments should set it too. Without it we use
 * the address this request came in on, which is right whenever the TV and phones share a network.
 */
export async function publicOrigin(): Promise<string> {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3100";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}
