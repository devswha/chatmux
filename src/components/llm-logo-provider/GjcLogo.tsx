type GjcLogoProps = {
  className?: string;
};

// ChatMux Code shares the product's crossed-channel multiplexer mark so its
// sessions remain distinct from Claude, Codex, Cursor, and OpenCode.
const GjcLogo = ({ className = 'w-5 h-5' }: GjcLogoProps) => (
  <img src="/logo.png" alt="ChatMux Code" className={`${className} object-contain`} />
);

export default GjcLogo;
