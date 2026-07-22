type GjcLogoProps = {
  className?: string;
};

// Official Gajae Code character mark, optimized from the upstream MIT-licensed
// asset for compact provider badges. Its license is shipped beside the image.
const GjcLogo = ({ className = 'w-5 h-5' }: GjcLogoProps) => (
  <img
    src="/providers/gajae-code.png"
    alt="Gajae Code"
    className={`${className} object-contain`}
  />
);

export default GjcLogo;
