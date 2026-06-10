import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Photo Match',
  description: 'WhatsApp photo matching tool',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Photo Match',
  },
  icons: {
    icon: [
      { url: '/icons/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/icons/icon-180.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#09090b',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">

          <>
            <Script 
              src="https://unpkg.com/vconsole@latest/dist/vconsole.min.js" 
              strategy="lazyOnload" 
            />
            <Script id="vconsole-init" strategy="lazyOnload">
              {`
                window.onload = function() {
                  if (window.VConsole) {
                    new window.VConsole();
                  }
                };
              `}
            </Script>
          </>

{children}</body>
    </html>
  )
}
