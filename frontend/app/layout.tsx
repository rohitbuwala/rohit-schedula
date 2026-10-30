import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Medrella | Modern Healthcare Platform",
  description: "Medrella healthcare appointment and clinic management platform.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-white font-sans text-slate-900">{children}</body>
    </html>
  );
}
