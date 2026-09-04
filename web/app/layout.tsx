import type { Metadata, Viewport } from "next";
import {
  AUTHOR,
  DESCRIPTION,
  SITE_NAME,
  SITE_URL,
  TAGLINE,
  TITLE,
} from "@/lib/site";
import { mono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: `%s · ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: AUTHOR.name, url: AUTHOR.url }],
  creator: AUTHOR.name,
  publisher: AUTHOR.name,
  category: "technology",
  keywords: [
    "ethereum",
    "mempool",
    "mev",
    "private order flow",
    "private transactions",
    "block builders",
    "bundles",
    "blockchain visualization",
  ],
  alternates: { canonical: "/" },
  formatDetection: { email: false, address: false, telephone: false },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
  },
  // Images are not listed here on purpose: app/opengraph-image.tsx feeds both
  // og:image and, through Next's fallback, twitter:image.
  twitter: {
    card: "summary_large_image",
    site: AUTHOR.handle,
    creator: AUTHOR.handle,
    title: TITLE,
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

/**
 * Structured data, the way the Next guide on JSON-LD recommends: a script in
 * the layout. One WebSite with its author, no more. It says who made this
 * and what it is in a form a crawler does not have to infer from the page,
 * and it repeats nothing the meta tags do not already say.
 */
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  alternateName: TITLE,
  url: SITE_URL,
  description: DESCRIPTION,
  inLanguage: "en",
  about: TAGLINE,
  author: {
    "@type": "Person",
    name: AUTHOR.name,
    url: AUTHOR.url,
    sameAs: [AUTHOR.x],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${mono.variable} h-full antialiased`}
    >
      <body className="bg-void text-text flex min-h-full flex-col">
        <script
          type="application/ld+json"
          // Every string here is a literal from lib/site.ts; the escape is the
          // guide's, kept so a future value cannot close the script early.
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
          }}
        />
        {children}
      </body>
    </html>
  );
}
