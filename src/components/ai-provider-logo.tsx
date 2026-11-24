import { useId } from 'react'
import { Plug } from 'lucide-react'
import type { AIBrandId } from '@/lib/ai-brand'
import { cn } from '@/lib/utils'

/** Crisp offline SVG brand marks for all supported AI Agents (CLI) and API providers. */
export function AIProviderLogo({ brand, className = 'h-4 w-4' }: { brand: AIBrandId; className?: string }) {
  const uid = useId().replace(/:/g, '')

  switch (brand) {
    case 'codex-cli':
    case 'openai':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn('shrink-0', className)}>
          <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.896zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
        </svg>
      )

    case 'claude-code':
    case 'anthropic':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#D97757]', className)}>
          <path
            d="M12 2.25v5.6m0 8.3v5.6M2.25 12h5.6m8.3 0h5.6M5.1 5.1l3.95 3.95m5.9 5.9 3.95 3.95M18.9 5.1l-3.95 3.95m-5.9 5.9L5.1 18.9M8.27 3.02l2.14 5.18m3.18 7.6 2.14 5.18M3.02 15.73l5.18-2.14m7.6-3.18 5.18-2.14M3.02 8.27l5.18 2.14m7.6 3.18 5.18 2.14M15.73 3.02l-2.14 5.18m-3.18 7.6-2.14 5.18"
            stroke="currentColor"
            strokeWidth="1.95"
            strokeLinecap="round"
          />
        </svg>
      )

    case 'gemini-cli':
    case 'gemini':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0', className)}>
          <defs>
            <linearGradient id={`sb-gemini-${uid}`} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#4285F4" />
              <stop offset="55%" stopColor="#8B5CF6" />
              <stop offset="100%" stopColor="#EC4899" />
            </linearGradient>
          </defs>
          <path
            d="M12 2c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10 5.2-.6 9.4-4.8 10-10Z"
            fill={`url(#sb-gemini-${uid})`}
          />
        </svg>
      )

    case 'opencode-cli':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0', className)}>
          <rect x="4" y="3" width="16" height="18" rx="2.2" stroke="currentColor" strokeWidth="2.4" />
          <rect x="8.5" y="8" width="7" height="8" rx="0.8" fill="currentColor" opacity="0.55" />
        </svg>
      )

    case 'cursor-cli':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0', className)}>
          <path d="M12 2.2 20.5 7.1v9.8L12 21.8 3.5 16.9V7.1L12 2.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M12 2.2v9.8l8.5-4.9-8.5-4.9Z" fill="currentColor" opacity="0.22" />
          <path d="M12 12 20.5 7.1v9.8L12 21.8V12Z" fill="currentColor" opacity="0.88" />
          <path d="M12 12 3.5 7.1v9.8L12 21.8V12Z" fill="currentColor" opacity="0.45" />
        </svg>
      )

    case 'devin-cli':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#2DD4BF]', className)}>
          <path d="M6.5 7.5a5.5 5.5 0 0 1 9.5-2.2l2.2 2.2a5.5 5.5 0 0 1 0 7.8l-1.5 1.5a5.5 5.5 0 0 1-7.8 0L6.5 14.4a5.5 5.5 0 0 1 0-6.9Z" stroke="currentColor" strokeWidth="2" />
          <circle cx="9.8" cy="11.5" r="1.8" fill="currentColor" />
          <circle cx="14.6" cy="12.5" r="1.8" fill="currentColor" opacity="0.7" />
        </svg>
      )

    case 'deepseek':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#4D6BFE]', className)}>
          <path
            d="M20.5 9.2c-.8 1.5-2.1 2.2-3.4 2.2-.3-3.1-2.8-5.4-6.3-5.4-3.7 0-6.8 2.8-6.8 6.4 0 3.7 3 6.6 7.2 6.6 3.5 0 6.1-1.9 7.1-4.8.9-.3 2.1-1.1 2.7-2.6.2-.6-.1-1.1-.5-1.1-.8 0-1.3.4-1.8.8.6-.8 1.2-1.4 1.8-2.1Z"
            fill="currentColor"
          />
          <circle cx="9.2" cy="11.4" r="1.2" fill="var(--workspace-surface-950, #090d16)" />
        </svg>
      )

    case 'openrouter':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#818CF8]', className)}>
          <path d="M4 12h4.2c1.8 0 3.1-1.1 4-2.8.9-1.7 2.2-2.7 4-2.7H20" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
          <path d="M4 12h4.2c1.8 0 3.1 1.1 4 2.8.9 1.7 2.2 2.7 4 2.7H20" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
          <path d="m17.5 4.2 2.5 2.3-2.5 2.3M17.5 15.2 20 17.5l-2.5 2.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )

    case 'xai':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn('shrink-0', className)}>
          <path d="M18.2 3h3.1l-6.8 7.8L22.5 21h-6.2l-4.9-6.3L5.9 21H2.8l7.3-8.3L2.3 3h6.4l4.4 5.8L18.2 3Zm-1.1 16.1h1.7L7.6 4.8H5.8l11.3 14.3Z" />
        </svg>
      )

    case 'groq':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#F55036]', className)}>
          <path d="M12 4a8 8 0 1 0 8 8v-1h-7v3h3.8A4.8 4.8 0 1 1 12 7.2c1.5 0 2.8.6 3.7 1.6l2.2-2.1A7.9 7.9 0 0 0 12 4Z" fill="currentColor" />
        </svg>
      )

    case 'qwen':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#615CED]', className)}>
          <path
            d="M12 2.5 14.7 7.3l5.5-.1-2.8 4.8 2.8 4.8-5.5-.1L12 21.5l-2.7-4.8-5.5.1 2.8-4.8-2.8-4.8 5.5.1L12 2.5Z"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="2.6" fill="currentColor" />
        </svg>
      )

    case 'zhipu':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#3B82F6]', className)}>
          <path d="M5 6.5h14l-9.5 11H19" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="5.5" cy="17.5" r="2" fill="currentColor" />
        </svg>
      )

    case 'moonshot':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#38BDF8]', className)}>
          <path d="M18.6 15.2A7.5 7.5 0 0 1 8.8 5.4a7.5 7.5 0 1 0 9.8 9.8Z" fill="currentColor" />
          <circle cx="17.5" cy="6.5" r="1.6" fill="currentColor" />
        </svg>
      )

    case 'siliconflow':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#8B5CF6]', className)}>
          <path d="M12 3 20 8v8l-8 5-8-5V8l8-5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M8.5 10.2c1.2-1.2 2.4-1.2 3.5 0s2.3 1.2 3.5 0M8.5 13.8c1.2-1.2 2.4-1.2 3.5 0s2.3 1.2 3.5 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )

    case 'volcengine':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0', className)}>
          <defs>
            <linearGradient id={`sb-volc-${uid}`} x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#3B82F6" />
              <stop offset="100%" stopColor="#06B6D4" />
            </linearGradient>
          </defs>
          <path d="M12 3.5 21 19H3L12 3.5Z" fill={`url(#sb-volc-${uid})`} />
          <path d="M12 10.5 15.8 19H8.2L12 10.5Z" fill="var(--workspace-surface-950, #090d16)" opacity="0.55" />
        </svg>
      )

    case 'minimax':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0', className)}>
          <defs>
            <linearGradient id={`sb-mm-${uid}`} x1="3" y1="6" x2="21" y2="18" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#F43F5E" />
              <stop offset="100%" stopColor="#FB923C" />
            </linearGradient>
          </defs>
          <path d="M3.5 17V7l4.8 6.2L12 8.2l3.7 5L20.5 7v10" stroke={`url(#sb-mm-${uid})`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )

    case 'ollama':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0', className)}>
          <path d="M8.5 3.5c-1.1 0-1.8 1.1-1.5 2.6l.6 2.7A5.4 5.4 0 0 0 6 12.7c0 3.7 2.6 6.8 6 6.8s6-3.1 6-6.8a5.4 5.4 0 0 0-1.6-3.9l.6-2.7c.3-1.5-.4-2.6-1.5-2.6-.9 0-1.6.7-2 1.9l-.3 1.1a5.4 5.4 0 0 0-2.4 0l-.3-1.1c-.4-1.2-1.1-1.9-2-1.9Z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
          <circle cx="9.8" cy="12" r="1" fill="currentColor" />
          <circle cx="14.2" cy="12" r="1" fill="currentColor" />
          <path d="M10.5 15c.9.7 2.1.7 3 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )

    case 'lmstudio':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[#6366F1]', className)}>
          <path d="M12 3 4.5 7.2v9.6L12 21l7.5-4.2V7.2L12 3Z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
          <path d="M4.5 7.2 12 11.4l7.5-4.2M12 11.4V21" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
        </svg>
      )

    case 'api':
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('shrink-0 text-[var(--workspace-accent-text)]', className)}>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3.8 12h16.4M12 3.5c2.6 2.4 4 5.2 4 8.5s-1.4 6.1-4 8.5c-2.6-2.4-4-5.2-4-8.5s1.4-6.1 4-8.5Z" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      )

    case 'custom':
    default:
      return <Plug aria-hidden="true" className={cn('shrink-0', className)} />
  }
}
