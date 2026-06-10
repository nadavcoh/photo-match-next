'use client'

/**
 * src/app/login/page.tsx
 *
 * Minimal login page — a single "Sign in with GitHub" button.
 * After OAuth completes, Supabase redirects the browser to /auth/callback
 * which exchanges the code for a session and then redirects to /.
 *
 * If the middleware boots the user for having an unauthorised email it appends
 * ?error=unauthorized_email; this page surfaces that as a human-readable note.
 */

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { createClient } from '@/lib/supabase-client'

// ── GitHub SVG icon ────────────────────────────────────────────────────────────

function GitHubIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 98 96"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M48.9 0C21.9 0 0 22 0 49.2c0 21.8 13.9 40.2 33.1 46.7 2.4.5 3.3-1.1 3.3-2.4v-8.5c-13.5 2.9-16.3-6.5-16.3-6.5-2.2-5.6-5.4-7.1-5.4-7.1-4.4-3 .3-3 .3-3 4.9.4 7.5 5.1 7.5 5.1 4.4 7.5 11.4 5.3 14.2 4.1.4-3.2 1.7-5.3 3.1-6.5-10.8-1.2-22.1-5.4-22.1-24.1 0-5.3 1.9-9.7 5-13.1-.5-1.2-2.2-6.2.5-12.9 0 0 4.1-1.3 13.4 5.1 3.9-1.1 8-1.6 12.2-1.6s8.3.5 12.2 1.6c9.3-6.4 13.4-5.1 13.4-5.1 2.7 6.7 1 11.7.5 12.9 3.1 3.4 5 7.8 5 13.1 0 18.7-11.4 22.8-22.2 24 1.7 1.5 3.3 4.5 3.3 9.1v13.5c0 1.3.9 2.9 3.3 2.4C84.1 89.4 98 71 98 49.2 98 22 76.1 0 48.9 0z" />
    </svg>
  )
}

// ── Error banner ───────────────────────────────────────────────────────────────

function ErrorBanner() {
  const params = useSearchParams()
  const error = params.get('error')

  if (!error) return null

  const messages: Record<string, string> = {
    unauthorized_email:
      'That GitHub account is not authorised to access this app.',
    auth_error: 'Something went wrong during sign-in. Please try again.',
  }

  return (
    <div
      role="alert"
      style={{
        background: 'rgba(239,68,68,.12)',
        border: '1px solid rgba(239,68,68,.35)',
        borderRadius: 10,
        padding: '10px 14px',
        fontSize: '.8rem',
        color: '#fca5a5',
        marginBottom: 20,
        lineHeight: 1.45,
      }}
    >
      {messages[error] ?? 'An unexpected error occurred.'}
    </div>
  )
}

// ── Login button ───────────────────────────────────────────────────────────────

function SignInButton() {
  async function handleSignIn() {
    const supabase = createClient()
    await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        // After GitHub redirects back, /auth/callback exchanges the code for a
        // session and then sends the user to /.
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
  }

  return (
    <button
      onClick={handleSignIn}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '11px 20px',
        background: '#24292e',
        color: '#ffffff',
        border: '1px solid rgba(255,255,255,.1)',
        borderRadius: 10,
        fontSize: '.9rem',
        fontWeight: 600,
        cursor: 'pointer',
        transition: 'background .15s',
      }}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLButtonElement).style.background = '#2f363d')
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLButtonElement).style.background = '#24292e')
      }
    >
      <GitHubIcon />
      Sign in with GitHub
    </button>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 16px',
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 20,
          padding: '40px 32px',
          width: 'min(380px, 100%)',
          textAlign: 'center',
        }}
      >
        {/* Logo / title */}
        <div style={{ fontSize: '2.8rem', marginBottom: 10 }}>📷</div>
        <h1
          style={{
            fontSize: '1.25rem',
            fontWeight: 700,
            marginBottom: 6,
            color: 'var(--text)',
          }}
        >
          Photo Match
        </h1>
        <p
          style={{
            fontSize: '.82rem',
            color: 'var(--muted)',
            marginBottom: 28,
            lineHeight: 1.5,
          }}
        >
          Sign in to access your WhatsApp photo matching tool.
        </p>

        {/* Error banner — needs useSearchParams so it lives in a Suspense boundary */}
        <Suspense>
          <ErrorBanner />
        </Suspense>

        {/* OAuth button */}
        <SignInButton />
      </div>
    </div>
  )
}
