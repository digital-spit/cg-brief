import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "C&G Brief — Trading Dashboard",
  description: "Financial briefing dashboard with live market data",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
