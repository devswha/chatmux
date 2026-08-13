import { useId } from 'react';

type OmoLogoProps = {
  className?: string;
};

/**
 * Placeholder mark: the omo package ships no brand asset, so this is a plain
 * geometric "o" rather than an official logo. Swap it when one exists.
 */
const OmoLogo = ({ className = 'w-5 h-5' }: OmoLogoProps) => {
  const gradientId = useId();

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="omo"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7dd3fc" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="12" fill="#0b1220" />
      <circle cx="32" cy="32" r="14" fill="none" stroke={`url(#${gradientId})`} strokeWidth="7" />
    </svg>
  );
};

export default OmoLogo;
