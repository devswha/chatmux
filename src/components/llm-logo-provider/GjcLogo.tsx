type GjcLogoProps = {
  className?: string;
};

// Gajae Code is an independent coding agent. Keep its provider mark visually
// separate from both the ChatMux product identity and the other agent logos.
const GjcLogo = ({ className = 'w-5 h-5' }: GjcLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Gajae Code"
    className={className}
  >
    <rect width="24" height="24" rx="6" fill="#18181b" />
    <path d="M7.5 8 4.5 4M16.5 8l3-4" stroke="#ff4d4f" strokeWidth="2" strokeLinecap="round" />
    <rect x="4.5" y="7" width="15" height="12" rx="5" fill="#ef3b24" />
    <rect x="7" y="9.5" width="10" height="6" rx="2.5" fill="#111827" />
    <circle cx="10" cy="12.5" r="1" fill="#34d399" />
    <circle cx="14" cy="12.5" r="1" fill="#34d399" />
    <path d="M9 18h6" stroke="#fbbf24" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export default GjcLogo;
