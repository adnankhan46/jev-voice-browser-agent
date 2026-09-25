import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Jev Browser Agent", description: "Voice and text control for your browser agent" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
