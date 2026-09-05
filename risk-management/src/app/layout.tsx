import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "@/styles/globals.css";
import { validateEnv } from "@/lib/env/validate";
import { brand, brandCssOverrides } from "@/config/brand";

// Validate environment variables on cold start
const envCheck = validateEnv();
if (!envCheck.valid) {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Missing required environment variables",
      missing: envCheck.missing,
      timestamp: new Date().toISOString(),
    })
  );
}

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: `${brand.productName} Platform`,
  description: brand.tagline,
  ...(brand.faviconUrl ? { icons: { icon: brand.faviconUrl } } : {}),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cssOverrides = brandCssOverrides();

  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-background min-h-screen antialiased`}>
        {cssOverrides && <style>{cssOverrides}</style>}
        {children}
      </body>
    </html>
  );
}
