import type { Metadata } from "next";
import { DM_Sans, Sora } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";
import { APP_NAME } from "@/lib/brand";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
  description:
    "Agent software factory: GitHub issues in, reviewed pull requests out, powered by Codex subscriptions.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en-AU" className={`${sora.variable} ${dmSans.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
