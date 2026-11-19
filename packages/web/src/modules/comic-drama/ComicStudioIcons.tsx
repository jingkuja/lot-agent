import type { ReactNode } from "react";

type IconProps = { size?: number };

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function NewEpisodeIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function ClapperboardIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M4 11h16v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Z" />
      <path d="M4 11V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" />
      <path d="m8 5 2 6M14 5l2 6" />
    </Icon>
  );
}

export function EpisodesIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4" />
    </Icon>
  );
}

export function CharactersIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="10" cy="8" r="3.2" />
      <path d="M4 19c.7-3.4 2.8-5 6-5s5.3 1.6 6 5" />
      <path d="M18.5 5.5 19.3 7.7 21.5 8.5 19.3 9.3 18.5 11.5 17.7 9.3 15.5 8.5 17.7 7.7Z" />
    </Icon>
  );
}

export function MaterialsIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </Icon>
  );
}

export function SettingsIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M4 7h8M16 7h4M4 12h4M12 12h8M4 17h10M18 17h2" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="16" cy="17" r="2" />
    </Icon>
  );
}

export function VideoReelIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <polygon points="10,9.5 15.5,12 10,14.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function TimelineEditIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M4 6h6M4 12h12M4 18h9" />
      <rect x="12" y="4.5" width="8" height="3" rx="1" />
      <rect x="15" y="16.5" width="5" height="3" rx="1" />
      <path d="M14 3v18" />
    </Icon>
  );
}

export function ExportBoxIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 15V4M8 8l4-4 4 4" />
      <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </Icon>
  );
}

export function ScriptIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M6 4h9l4 4v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V5.5A1.5 1.5 0 0 1 6 4Z" />
      <path d="M15 4v4h4M8 12h8M8 16h5" />
    </Icon>
  );
}

export function StoryboardIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16M15.5 4v16M3 10.5h6.5M15.5 13.5H21" />
    </Icon>
  );
}

export function SparklesIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
      <path d="M19 3v3M20.5 4.5h-3M5 17v3M6.5 18.5h-3" />
    </Icon>
  );
}

export function ArrowRightIcon({ size = 14 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  );
}

/** Editorial storyboard drafting-desk artwork rendered with theme CSS variables only. */
export function StudioDeskArtwork() {
  return (
    <div className="comic-hero-stage" aria-hidden="true">
      <svg className="comic-hero-art" viewBox="0 0 460 320" fill="none">
        <defs>
          <linearGradient id="comic-art-wash" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="52%" stopColor="var(--accent-2)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--gold)" stopOpacity="0.24" />
          </linearGradient>
          <linearGradient id="comic-art-sky" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent-2)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--tag-image-fg)" stopOpacity="0.24" />
          </linearGradient>
          <linearGradient id="comic-art-warm" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--error)" stopOpacity="0.2" />
          </linearGradient>
          <pattern id="comic-halftone" width="12" height="12" patternUnits="userSpaceOnUse">
            <circle cx="2.5" cy="2.5" r="1.15" fill="var(--accent)" fillOpacity="0.22" />
          </pattern>
        </defs>

        {/* Soft studio drafting mat */}
        <rect x="16" y="18" width="428" height="284" rx="22" fill="url(#comic-art-wash)" stroke="var(--border)" strokeWidth="1.2" />
        <rect x="26" y="28" width="408" height="264" rx="16" fill="url(#comic-halftone)" opacity="0.55" />

        {/* Back-left vertical 9:16 manga frame */}
        <g className="comic-art-panel-a">
          <rect x="38" y="42" width="134" height="186" rx="14" fill="var(--bg-card)" stroke="var(--border)" strokeWidth="1.5" />
          <rect x="48" y="52" width="114" height="114" rx="10" fill="url(#comic-art-sky)" />
          <circle cx="132" cy="80" r="16" fill="var(--gold)" fillOpacity="0.82" />
          <path d="M48 142 C72 114, 96 122, 118 136 C134 124, 148 122, 162 134 L162 166 L48 166 Z" fill="var(--accent)" fillOpacity="0.65" />
          <path d="M48 152 C74 134, 112 136, 162 150 L162 166 L48 166 Z" fill="var(--accent-2)" fillOpacity="0.55" />
          {/* Speech bubble inside frame */}
          <rect x="56" y="60" width="48" height="22" rx="11" fill="var(--bg-card)" stroke="var(--accent)" strokeWidth="1.2" />
          <line x1="66" y1="71" x2="94" y2="71" stroke="var(--text-secondary)" strokeWidth="2.2" strokeLinecap="round" />
          {/* Frame footer lines */}
          <rect x="48" y="176" width="32" height="12" rx="6" fill="var(--accent)" fillOpacity="0.18" />
          <line x1="88" y1="182" x2="156" y2="182" stroke="var(--text-muted)" strokeWidth="2.4" strokeLinecap="round" strokeOpacity="0.45" />
          <line x1="48" y1="202" x2="136" y2="202" stroke="var(--text-muted)" strokeWidth="2.4" strokeLinecap="round" strokeOpacity="0.3" />
          <line x1="48" y1="214" x2="108" y2="214" stroke="var(--text-muted)" strokeWidth="2.4" strokeLinecap="round" strokeOpacity="0.22" />
        </g>

        {/* Center hero cinema storyboard card */}
        <g className="comic-art-panel-b">
          <rect x="190" y="34" width="232" height="156" rx="16" fill="var(--bg-card)" stroke="var(--accent)" strokeWidth="1.6" strokeOpacity="0.65" />
          <rect x="202" y="46" width="208" height="106" rx="11" fill="url(#comic-art-warm)" />
          {/* Dynamic anime speed lines */}
          <path d="M214 56 L248 76 M228 50 L254 68 M396 56 L362 78 M402 74 L374 88" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
          {/* Viewfinder framing corners */}
          <path d="M216 68 V58 H226 M396 68 V58 H386 M216 130 V140 H226 M396 130 V140 H386" stroke="var(--text)" strokeWidth="1.6" strokeOpacity="0.45" strokeLinecap="round" />
          {/* Stylized character silhouette + cape arc */}
          <circle cx="306" cy="84" r="14" fill="var(--text)" fillOpacity="0.72" />
          <path d="M276 152 C282 116, 294 104, 306 104 C318 104, 332 116, 344 152 Z" fill="var(--accent)" fillOpacity="0.78" />
          <path d="M318 108 C342 112, 360 124, 370 144 C350 144, 336 146, 326 152 Z" fill="var(--tag-image-fg)" fillOpacity="0.58" />
          {/* Sparkle star */}
          <path d="M366 64 L369 72 L377 75 L369 78 L366 86 L363 78 L355 75 L363 72 Z" fill="var(--gold)" />
          {/* Slate caption bar */}
          <circle cx="212" cy="171" r="4.5" fill="var(--accent)" />
          <line x1="225" y1="171" x2="314" y2="171" stroke="var(--text)" strokeWidth="2.8" strokeLinecap="round" strokeOpacity="0.6" />
          <rect x="356" y="162" width="54" height="18" rx="9" fill="var(--accent)" fillOpacity="0.16" />
          <line x1="368" y1="171" x2="398" y2="171" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
        </g>

        {/* Bottom multi-track NLE studio bar */}
        <g className="comic-art-timeline">
          <rect x="190" y="204" width="232" height="76" rx="14" fill="var(--bg-card)" stroke="var(--border)" strokeWidth="1.4" />
          {/* Track 1: video */}
          <rect x="204" y="216" width="66" height="13" rx="4" fill="var(--accent)" fillOpacity="0.82" />
          <rect x="274" y="216" width="84" height="13" rx="4" fill="var(--accent)" fillOpacity="0.52" />
          <rect x="362" y="216" width="46" height="13" rx="4" fill="var(--accent)" fillOpacity="0.34" />
          {/* Track 2: voice & music */}
          <rect x="218" y="236" width="112" height="11" rx="4" fill="var(--accent-2)" fillOpacity="0.72" />
          <rect x="336" y="236" width="62" height="11" rx="4" fill="var(--tag-image-fg)" fillOpacity="0.65" />
          {/* Track 3: subtitles & sfx */}
          <rect x="204" y="254" width="90" height="10" rx="4" fill="var(--gold)" fillOpacity="0.78" />
          <rect x="302" y="254" width="82" height="10" rx="4" fill="var(--error)" fillOpacity="0.46" />
          {/* Glowing playhead */}
          <line x1="296" y1="208" x2="296" y2="276" stroke="var(--error)" strokeWidth="2" strokeLinecap="round" />
          <polygon points="291,208 301,208 296,215" fill="var(--error)" />
        </g>

        {/* Floating pigment swatch badge */}
        <g className="comic-art-swatch">
          <rect x="46" y="242" width="126" height="38" rx="12" fill="var(--bg-card)" stroke="var(--border)" strokeWidth="1.4" />
          <circle cx="67" cy="261" r="7.5" fill="var(--accent)" />
          <circle cx="88" cy="261" r="7.5" fill="var(--accent-2)" />
          <circle cx="109" cy="261" r="7.5" fill="var(--gold)" />
          <circle cx="130" cy="261" r="7.5" fill="var(--tag-image-fg)" />
          <circle cx="151" cy="261" r="7.5" fill="var(--error)" fillOpacity="0.82" />
        </g>
      </svg>
    </div>
  );
}
