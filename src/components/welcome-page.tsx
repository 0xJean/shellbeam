import { useState, useEffect } from 'react'
import {
  Terminal, FolderSync, Network, Sparkles, Shield,
  Code2, RefreshCw, ArrowRight, ChevronRight, Activity, Cable,
} from 'lucide-react'
import { useT } from '@/lib/i18n'
import logoUrl from '@/assets/logo.png'

const FEATURES = [
  { icon: Terminal, titleKey: 'welcome.sshTerminal', descKey: 'welcome.sshTerminalDesc', color: '#3b82f6' },
  { icon: FolderSync, titleKey: 'welcome.sftpTransfer', descKey: 'welcome.sftpTransferDesc', color: '#10b981' },
  { icon: Network, titleKey: 'welcome.portForwarding', descKey: 'welcome.portForwardingDesc', color: '#f59e0b' },
  { icon: Sparkles, titleKey: 'welcome.aiAssistant', descKey: 'welcome.aiAssistantDesc', color: '#8b5cf6' },
  { icon: Shield, titleKey: 'welcome.encryptedVault', descKey: 'welcome.encryptedVaultDesc', color: '#ef4444' },
  { icon: Code2, titleKey: 'welcome.snippets', descKey: 'welcome.snippetsDesc', color: '#06b6d4' },
  { icon: RefreshCw, titleKey: 'welcome.crossDeviceSync', descKey: 'welcome.crossDeviceSyncDesc', color: '#ec4899' },
  { icon: Activity, titleKey: 'welcome.monitor', descKey: 'welcome.monitorDesc', color: '#10b981' },
  { icon: Cable, titleKey: 'welcome.mcp', descKey: 'welcome.mcpDesc', color: '#06b6d4' },
] as const

export function WelcomePage({ onDismiss, onOpenGuide }: { onDismiss: () => void; onOpenGuide: () => void }) {
  const { t } = useT()
  const [step, setStep] = useState(0)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setStep(1), 600)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden bg-[#060810]" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      {/* Animated background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(19,91,236,0.25),transparent)]" />
        <div className="welcome-grid absolute inset-0 opacity-[0.04]" />
        {Array.from({ length: 40 }).map((_, i) => (
          <div key={i} className="welcome-particle absolute rounded-full bg-blue-400/60"
            style={{
              width: `${1.5 + i % 3}px`, height: `${1.5 + i % 3}px`,
              left: `${(i * 37) % 100}%`, top: `${(i * 61) % 100}%`,
              animationDelay: `${i % 6}s`, animationDuration: `${4 + i % 4}s`,
            }} />
        ))}
        <div className="welcome-beam absolute left-1/2 top-[18%] h-[2px] w-0 -translate-x-1/2 bg-gradient-to-r from-transparent via-blue-400/80 to-transparent"
          style={{ animationDelay: '0.8s' }} />
      </div>

      <div className={`relative flex max-h-[min(720px,90vh)] w-full max-w-[860px] flex-col items-center gap-6 px-6 transition-all duration-1000 ${entered ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'}`}>
        {/* Hero */}
        <div className="flex flex-col items-center gap-4">
          <div className="welcome-logo-glow relative">
            <img src={logoUrl} alt="ShellBeam" className="h-24 w-24 rounded-2xl shadow-2xl shadow-blue-500/30" />
          </div>
          <div className={`flex flex-col items-center gap-2 transition-all duration-700 delay-300 ${step >= 1 ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}>
            <h1 className="bg-gradient-to-r from-blue-300 via-blue-100 to-blue-300 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
              ShellBeam
            </h1>
            <p className="text-center text-sm leading-relaxed text-blue-200/50">
              {t('welcome.tagline')}
            </p>
          </div>
        </div>

        {/* Feature cards */}
        <div className={`w-full overflow-y-auto overscroll-contain py-2 transition-all duration-700 delay-500 ${step >= 1 ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'}`}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <div key={f.titleKey}
                className="welcome-card group relative overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 backdrop-blur-sm transition-all hover:border-white/[0.12] hover:bg-white/[0.06]"
                style={{ animationDelay: `${0.7 + i * 0.08}s` }}>
                <div className="absolute inset-0 rounded-xl opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ background: `radial-gradient(circle at 30% 30%, ${f.color}10, transparent 70%)` }} />
                <div className="relative flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: `${f.color}18` }}>
                    <f.icon className="h-4.5 w-4.5" style={{ color: f.color }} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-[13px] font-semibold text-white/90">{t(f.titleKey)}</h3>
                    <p className="mt-0.5 text-[11px] leading-[1.5] text-white/40">{t(f.descKey)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className={`flex shrink-0 flex-col items-center gap-3 pb-2 transition-all duration-700 delay-700 ${step >= 1 ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}>
          <button type="button" onClick={onOpenGuide}
            className="welcome-cta group flex items-center gap-2.5 rounded-full bg-primary px-7 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:shadow-blue-500/40">
            {t('guide.start')}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </button>
          <button type="button" onClick={onDismiss} className="text-xs text-white/60 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{t('guide.skip')}</button>
          <div className="flex items-center gap-1 text-[11px] text-white/25">
            <ChevronRight className="h-3 w-3" />
            <span>{t('guide.reopenHint')}</span>
          </div>
        </div>
      </div>

      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .welcome-particle, .welcome-beam, .welcome-card, .welcome-cta, .welcome-logo-glow::after { animation: none !important; }
        }
        .welcome-grid {
          background-image:
            linear-gradient(rgba(19,91,236,0.15) 1px, transparent 1px),
            linear-gradient(90deg, rgba(19,91,236,0.15) 1px, transparent 1px);
          background-size: 60px 60px;
          mask-image: radial-gradient(ellipse 60% 50% at 50% 40%, black, transparent);
        }
        .welcome-particle {
          animation: welcomeFloat linear infinite;
        }
        @keyframes welcomeFloat {
          0%, 100% { opacity: 0; transform: translateY(0); }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { opacity: 0; transform: translateY(-80px); }
        }
        .welcome-beam {
          animation: welcomeBeam 1.2s ease-out forwards;
          animation-play-state: paused;
        }
        .welcome-beam { animation-play-state: running; }
        @keyframes welcomeBeam {
          0% { width: 0; opacity: 0; }
          30% { opacity: 1; }
          100% { width: 60%; opacity: 0; }
        }
        .welcome-logo-glow::after {
          content: '';
          position: absolute;
          inset: -8px;
          border-radius: 20px;
          background: radial-gradient(circle, rgba(19,91,236,0.35), transparent 70%);
          animation: welcomeGlow 3s ease-in-out infinite;
        }
        @keyframes welcomeGlow {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.08); }
        }
        .welcome-card {
          animation: welcomeCardIn 0.5s ease-out both;
        }
        @keyframes welcomeCardIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .welcome-cta {
          animation: welcomePulse 2.5s ease-in-out infinite;
          animation-delay: 1.5s;
        }
        @keyframes welcomePulse {
          0%, 100% { box-shadow: 0 10px 25px -5px rgba(19,91,236,0.25); }
          50% { box-shadow: 0 10px 35px -5px rgba(19,91,236,0.45); }
        }
      `}</style>
    </div>
  )
}
