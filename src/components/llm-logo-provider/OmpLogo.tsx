type OmpLogoProps = {
  className?: string;
};

/** Compact π mark for Oh My Pi provider badges. */
const OmpLogo = ({ className = 'w-5 h-5' }: OmpLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Oh My Pi"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="10" fill="currentColor" />
    <path
      d="M6.25 7.4h11.5M9.35 7.4v8.1c0 1.15-.48 1.85-1.45 2.1M14.65 7.4v8.3c0 1.27.57 1.9 1.72 1.9"
      fill="none"
      className="stroke-background"
      strokeWidth="2.15"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default OmpLogo;
