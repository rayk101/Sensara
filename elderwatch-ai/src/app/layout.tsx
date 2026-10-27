import type { Metadata } from "next";
import "./globals.css";
import "../../public/button-shape.css";

export const metadata: Metadata = {
  title: "Sensara — Visual Safety Monitoring",
  description:
    "Prototype visual safety monitoring assistant for elderly care homes. Not a medical device.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-sensara-cream min-h-screen">{children}</body>
    </html>
  );
}
