import type { Metadata } from "next";
import TradingTerminal from "@/components/terminal/TradingTerminal";

export const metadata: Metadata = {
  title: "Trading Terminal (Paper)",
  description: "Simulated paper-trading terminal. Not financial advice; no real market data.",
};

export default function TerminalPage() {
  return <TradingTerminal />;
}
