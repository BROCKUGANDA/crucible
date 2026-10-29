"use client";

export function SponsorshipGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={`glyph glyph--drop ${className}`} viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false">
      <path d="M12 2 C 12 2, 6 9, 6 14 a6 6 0 0 0 12 0 C 18 9, 12 2, 12 2 Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9 15 a3 3 0 0 0 3 3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

export function AirdropGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={`glyph glyph--chute ${className}`} viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false">
      <path d="M4 9 Q 12 2, 20 9 L 18 11 Q 12 6, 6 11 Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <line x1="12" y1="9" x2="12" y2="15" stroke="currentColor" strokeWidth="1.2" />
      <rect x="10" y="15" width="4" height="4" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="10" y1="17" x2="8" y2="19" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <line x1="14" y1="17" x2="16" y2="19" stroke="currentColor" strokeWidth="1" opacity="0.5" />
    </svg>
  );
}

export function StakingGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={`glyph glyph--stake ${className}`} viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false">
      <line x1="12" y1="3" x2="12" y2="20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8 7 L 12 3 L 16 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <line x1="9" y1="12" x2="15" y2="12" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
      <line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function EngramGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={`glyph glyph--engram ${className}`} viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false">
      <path d="M12 2 L 20 8 L 20 16 L 12 22 L 4 16 L 4 8 Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12 6 L 16 9 L 16 15 L 12 18 L 8 15 L 8 9 Z" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
