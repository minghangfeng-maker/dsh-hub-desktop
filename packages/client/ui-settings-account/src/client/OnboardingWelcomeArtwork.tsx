/**
 * First-run artwork drawn for DSH Hub.
 *
 * The upstream page showed screenshots of the official product under its own
 * wordmark; a fork that ships as DSH Hub cannot reuse them as its own product
 * image, so this is an abstract workspace sketch instead: a window with
 * a session rail, two turns, a composer, and a floating file list. Every fill
 * reads a theme token, so light and dark use the same markup.
 * @returns decorative artwork; the heading next to it carries the meaning.
 */
export function OnboardingWelcomeArtwork({ className = '' }: { className?: string | undefined }) {
  return <div className={`illustration ${className}`.trim()} aria-hidden="true">
    <svg viewBox="0 0 1331 822" role="presentation" focusable="false">
      <defs>
        <radialGradient id="dsh-hub-onboarding-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#4D6BFE" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#4D6BFE" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="dsh-hub-onboarding-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4D6BFE" />
          <stop offset="100%" stopColor="#3152D9" />
        </linearGradient>
      </defs>
      <ellipse cx="820" cy="400" rx="470" ry="380" fill="url(#dsh-hub-onboarding-halo)" />
      {/* Session window. */}
      <g>
        <rect x="352" y="96" width="744" height="556" rx="20" fill="var(--dsw-alias-bg-base)" stroke="var(--dsw-alias-border-l3)" />
        <circle cx="386" cy="126" r="5" fill="var(--dsw-alias-border-l4)" />
        <circle cx="404" cy="126" r="5" fill="var(--dsw-alias-border-l4)" />
        <circle cx="422" cy="126" r="5" fill="var(--dsw-alias-border-l4)" />
        <line x1="352" y1="156" x2="1096" y2="156" stroke="var(--dsw-alias-border-l2)" />
        {/* Session rail. */}
        <rect x="376" y="184" width="188" height="34" rx="10" fill="var(--dsw-alias-bg-skeleton)" />
        <rect x="376" y="234" width="150" height="14" rx="7" fill="var(--dsw-alias-border-l3)" />
        <rect x="376" y="266" width="170" height="14" rx="7" fill="var(--dsw-alias-border-l3)" />
        <rect x="376" y="298" width="128" height="14" rx="7" fill="var(--dsw-alias-border-l3)" />
        <rect x="376" y="330" width="158" height="14" rx="7" fill="var(--dsw-alias-border-l3)" />
        {/* Turns. */}
        <rect x="596" y="196" width="330" height="16" rx="8" fill="var(--dsw-alias-border-l3)" />
        <rect x="596" y="226" width="248" height="16" rx="8" fill="var(--dsw-alias-border-l3)" />
        <g>
          <rect x="596" y="278" width="466" height="150" rx="14" fill="var(--dsw-alias-bg-skeleton)" />
          <rect x="620" y="304" width="300" height="13" rx="6.5" fill="var(--dsw-alias-border-l3)" />
          <rect x="620" y="332" width="404" height="13" rx="6.5" fill="var(--dsw-alias-border-l3)" />
          <rect x="620" y="360" width="356" height="13" rx="6.5" fill="var(--dsw-alias-border-l3)" />
          <rect x="620" y="394" width="120" height="12" rx="6" fill="url(#dsh-hub-onboarding-tile)" opacity="0.5" />
        </g>
        {/* Composer. */}
        <rect x="596" y="462" width="466" height="72" rx="16" fill="var(--dsw-alias-bg-base)" stroke="var(--dsw-alias-border-l3)" />
        <rect x="622" y="488" width="210" height="13" rx="6.5" fill="var(--dsw-alias-border-l3)" />
        <circle cx="1018" cy="498" r="15" fill="url(#dsh-hub-onboarding-tile)" />
        <path d="M1012 498h12M1019 493l5 5-5 5" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {/* Rail footer: the account row. */}
        <circle cx="398" cy="580" r="13" fill="var(--dsw-alias-bg-skeleton)" stroke="var(--dsw-alias-border-l2)" />
        <rect x="420" y="574" width="96" height="13" rx="6.5" fill="var(--dsw-alias-border-l3)" />
      </g>
      {/* Floating file list. */}
      <g>
        <rect x="244" y="430" width="288" height="196" rx="16" fill="var(--dsw-alias-bg-base)" stroke="var(--dsw-alias-border-l3)" />
        <rect x="272" y="458" width="132" height="14" rx="7" fill="var(--dsw-alias-label-primary)" opacity="0.6" />
        <rect x="272" y="496" width="204" height="12" rx="6" fill="var(--dsw-alias-border-l3)" />
        <rect x="272" y="528" width="176" height="12" rx="6" fill="var(--dsw-alias-border-l3)" />
        <rect x="272" y="560" width="196" height="12" rx="6" fill="var(--dsw-alias-border-l3)" />
        <rect x="272" y="592" width="120" height="12" rx="6" fill="var(--dsw-alias-border-l3)" />
      </g>
      {/* Brand plate: the tile the installer, tray, and window icon share. */}
      <g>
        <rect x="900" y="636" width="196" height="56" rx="16" fill="var(--dsw-alias-bg-base)" stroke="var(--dsw-alias-border-l3)" />
        <rect x="914" y="646" width="36" height="36" rx="10" fill="url(#dsh-hub-onboarding-tile)" />
        <rect x="966" y="652" width="86" height="11" rx="5.5" fill="var(--dsw-alias-label-primary)" opacity="0.7" />
        <rect x="966" y="672" width="58" height="9" rx="4.5" fill="var(--dsw-alias-border-l3)" />
      </g>
    </svg>
  </div>
}
