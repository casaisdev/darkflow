import { Instrument } from "@/components/Instrument";
import { StreamProbe } from "@/components/StreamProbe";
import { About } from "@/components/About";

/**
 * The instrument at full height, and one paragraph under it.
 *
 * The paragraph is not marketing and not a landing page. It is there because
 * the apparatus produces a percentage and a percentage needs a referent: a
 * reader who does not already know what the public mempool is gets a number
 * with nothing behind it, which is the same as getting nothing.
 */
export default function Home() {
  return (
    // `contents` so the landmark adds no box: the instrument is sized against
    // the body, and a wrapper with a box of its own would sit between them.
    <main className="contents">
      <Instrument />
      <About />
      {/* Renders nothing. Logs the data layer with ?probe=1. */}
      <StreamProbe />
    </main>
  );
}
