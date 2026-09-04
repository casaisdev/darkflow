import type { Metadata, Viewport } from "next";
import { DESCRIPTION, SITE_NAME, SITE_URL, TAGLINE } from "@/lib/site";
import { mono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${TAGLINE}`,
    template: `%s · ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: "Martín Casais", url: "https://martincasais.com" }],
  creator: "Martín Casais",
  publisher: "Martín Casais",
  category: "technology",
  keywords: [
    "ethereum",
    "mempool",
    "mev",
    "private order flow",
    "block builders",
    "bundles",
    "realtime visualization",
  ],
  alternates: { canonical: "/" },
  formatDetection: { email: false, address: false, telephone: false },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${TAGLINE}`,
    description: DESCRIPTION,
    locale: "en_US",
  },
  // Images are not listed here on purpose: app/opengraph-image.tsx feeds both
  // og:image and, through Next's fallback, twitter:image.
  twitter: {
    card: "summary_large_image",
    site: "@casaisdev",
    creator: "@casaisdev",
    title: `${SITE_NAME} — ${TAGLINE}`,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export const viewport: Viewport = {
  themeColor: "#05070a",
  // No toggle, no light theme. This app is dark, full stop.
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${mono.variable} h-full antialiased`}
    >
      <body className="bg-void text-text flex min-h-full flex-col">
        {children}
      </body>
    </html>
  );
}
