/**
 * The club badge: "RSTC" set above the emblem, exactly as wide as it.
 *
 * The lettering is drawn here rather than taken from the artwork, so it can sit
 * on top at the emblem's width and follow the phone's theme: black on a light
 * screen, white on a dark one. An SVG `textLength` stretches it to the full
 * width whatever font the phone substitutes, which a CSS font size cannot.
 *
 * The emblem keeps two files because the artwork was made for a light
 * background: the dark copy has only its low-saturation pixels inverted, so
 * the blue duck and the circle are untouched. `picture` means the phone fetches
 * only the variant it will show.
 *
 * Plain `img` rather than `next/image`: one small static asset gives the
 * optimiser nothing to do. The intrinsic size is declared so the header does
 * not reflow as it loads.
 */
const EMBLEM_WIDTH = 160;
const EMBLEM_HEIGHT = 139;

export default function Logo({ className = "w-10 sm:w-11" }: { className?: string }) {
  return (
    <div className={`${className} flex shrink-0 flex-col gap-0.5`}>
      <svg
        viewBox="0 0 100 25"
        className="block w-full text-black dark:text-white"
        aria-hidden="true"
      >
        <text
          x="0"
          y="22"
          textLength="100"
          lengthAdjust="spacingAndGlyphs"
          fontSize="30"
          fontWeight="800"
          fontFamily="Arial, Helvetica, sans-serif"
          fill="currentColor"
        >
          RSTC
        </text>
      </svg>
      <picture className="contents">
        <source srcSet="/rstc-emblem-dark.png" media="(prefers-color-scheme: dark)" />
        <img
          src="/rstc-emblem.png"
          width={EMBLEM_WIDTH}
          height={EMBLEM_HEIGHT}
          alt="RSTC"
          className="block h-auto w-full"
        />
      </picture>
    </div>
  );
}
