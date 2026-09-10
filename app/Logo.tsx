/**
 * The club badge.
 *
 * Two files, not one, because the wordmark is set in pure black and would
 * disappear against the dark background the app takes from the phone's theme.
 * The emblem itself contains no near-black pixels at all, so the dark copy is
 * the same artwork with only its low-saturation pixels inverted: the duck and
 * the circle are untouched and the lettering lifts off the dark ground. That is
 * why this is not a CSS `invert` filter, which would turn the blue duck orange.
 *
 * `picture` rather than two `img` tags with `dark:hidden`, because a hidden
 * image is still downloaded: this way the phone fetches the one variant it will
 * actually show, and the header costs half as much on a club wifi connection.
 *
 * Plain `img` rather than `next/image`: one small static asset at a fixed
 * height gives the optimiser nothing to do. The intrinsic size is declared so
 * the header does not reflow as it loads.
 */
const NATURAL_WIDTH = 300;
const NATURAL_HEIGHT = 143;

export default function Logo({ className = "h-11 sm:h-12" }: { className?: string }) {
  return (
    // `display: contents` keeps the wrapper out of the layout entirely, so the
    // image itself is the flex item and the sizing classes land where they work.
    <picture className="contents">
      <source srcSet="/rstc-logo-dark.png" media="(prefers-color-scheme: dark)" />
      <img
        src="/rstc-logo.png"
        width={NATURAL_WIDTH}
        height={NATURAL_HEIGHT}
        alt="RSTC"
        className={`${className} w-auto shrink-0`}
      />
    </picture>
  );
}
