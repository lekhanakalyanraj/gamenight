import type { Metadata } from "next";

import { TvPairing } from "./tv-pairing";

export const metadata: Metadata = { title: "gamenight · TV" };

export default function TvPage() {
  return <TvPairing />;
}
