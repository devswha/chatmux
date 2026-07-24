import { useId } from 'react';

type OmpLogoProps = {
  className?: string;
};

/** Official Oh My Pi favicon mark from https://omp.sh/favicon.svg. */
const OmpLogo = ({ className = 'w-5 h-5' }: OmpLogoProps) => {
  const gradientId = useId();

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Oh My Pi"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ed4abf" />
          <stop offset=".5" stopColor="#9b4dff" />
          <stop offset="1" stopColor="#5ad8e6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="12" fill="#0f0a14" />
      <path fill={`url(#${gradientId})`} d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" />
    </svg>
  );
};

export default OmpLogo;
