type OpenCodeLogoProps = {
  className?: string;
};

/** Official square OpenCode mark from https://opencode.ai/brand. */
const OpenCodeLogo = ({ className = 'w-5 h-5' }: OpenCodeLogoProps) => (
  <svg
    viewBox="0 0 300 300"
    role="img"
    aria-label="OpenCode"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <g transform="translate(30 0)">
      <path
        d="M180 240H60V120H180V240Z"
        className="fill-[#CFCECD] dark:fill-[#4B4646]"
      />
      <path
        d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z"
        className="fill-[#211E1E] dark:fill-[#F1ECEC]"
      />
    </g>
  </svg>
);

export default OpenCodeLogo;
