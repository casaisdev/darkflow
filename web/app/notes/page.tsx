import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { AUTHOR, SITE_NAME, TITLE } from "@/lib/site";

const NOTES_TITLE = "Notes on method";
const NOTES_DESCRIPTION =
  "How Darkflow is built and verified, and the failures that produced a plausible picture before they were caught.";

/**
 * `openGraph` and `twitter` are set here because Next replaces those objects
 * whole rather than merging them: without them this page unfurled with the
 * home page's title and description under its own URL (measured on the
 * deployed site). Replacing the object also drops the share card the root
 * `opengraph-image.tsx` attaches, so the card is named again here.
 */
const CARD = { url: "/opengraph-image", width: 1200, height: 630, alt: TITLE };

export const metadata: Metadata = {
  title: NOTES_TITLE,
  description: NOTES_DESCRIPTION,
  alternates: { canonical: "/notes" },
  openGraph: {
    type: "article",
    url: "/notes",
    siteName: SITE_NAME,
    title: `${NOTES_TITLE} · ${SITE_NAME}`,
    description: NOTES_DESCRIPTION,
    locale: "en_US",
    images: [CARD],
  },
  twitter: {
    card: "summary_large_image",
    site: AUTHOR.handle,
    creator: AUTHOR.handle,
    title: `${NOTES_TITLE} · ${SITE_NAME}`,
    description: NOTES_DESCRIPTION,
    images: [CARD],
  },
};

/**
 * The method, and the failures that shaped it.
 *
 * Everything on this page already existed as comments next to the code it
 * describes, which is where it is useful to someone changing that code and
 * useless to anyone else. A reader with two minutes and the URL cannot see that
 * the range band waits twelve blocks or that the alpha decay was measured on a
 * scanline; they see a band and a field. This is the one place the method is
 * stated where a reader can find it.
 *
 * It is set in the About plate's type and measure, and nothing else: no
 * accent, no imagery, no new face. The warm colour on this site is spoken for.
 */

type Failure = {
  title: string;
  /** What the screen showed. */
  showed: string;
  /** Why nothing flagged it. */
  silent: string;
  /** How it was caught. */
  caught: string;
  where: string;
};

const FAILURES: readonly Failure[] = [
  {
    title: "A memory sized to block time",
    showed:
      "Hashes were remembered for three block times. Blocks reported up to 59% never seen against a generator that never exceeds 40%: the record had forgotten transactions that were still in the pool, and each one landed as private flow.",
    silent:
      "59% is a plausible figure for a block. Nothing about the picture was wrong except the number, and the number had no reference.",
    caught:
      "The probe compares the classifier against the generator’s own count of what it never announced. The two disagreed on every block.",
    where: "lib/seen.ts · tests/synthetic.test.ts",
  },
  {
    title: "Flights from the wrong pool",
    showed:
      "When a block landed, transactions flew from the 300-mark render sample instead of from the record of what had been seen. About 12% of a block’s public transactions had a mark to fly from, exactly the fifteen reserved for the highest fees, every block. The other 88% appeared in place, which is the picture of private flow.",
    silent:
      "Rows appearing in place is what the product is supposed to show. The animation was doing precisely what it was told.",
    caught:
      "Counting which rows arrived with a trajectory and comparing that to the count of public transactions in the block.",
    where: "lib/seen.ts · lib/canvas/world.ts",
  },
  {
    title: "An alpha that was NaN",
    showed:
      "Block marks were given firstSeen = NaN, on the reasoning that a transaction never announced has no earlier sighting. A NaN that reaches ctx.globalAlpha is ignored by the canvas, so every affected mark drew at full brightness, through weeks of verification captures that all looked fine.",
    silent:
      "The canvas does not throw on NaN. It keeps the previous alpha, and the previous alpha was a perfectly good one.",
    caught:
      "Measuring the decay along a scanline instead of looking at it. Marks that should have faded to the floor were at the ceiling.",
    where: "lib/canvas/world.ts · lib/canvas/draw.ts",
  },
  {
    title: "A solver that could not be wrong",
    showed:
      "The cubic-bezier easing solves x(t) = progress with Newton–Raphson and falls back to bisection. Flipping the derivative’s sign, swapping its coefficients, or reversing the Newton step left the entire easing suite green.",
    silent:
      "The bisection fallback is a complete solver on its own. It rescued every error Newton could make, at about thirty extra evaluations per call, and changed no result.",
    caught:
      "Mutation testing. The derivative is now exported and tested directly against a numerical one, so the fallback can no longer hide it.",
    where: "lib/easing.ts · tests/easing.test.ts",
  },
  {
    title: "0.0% on the block that closed calibration",
    showed:
      "The warm-up closes on the fifth block, and that block was classified before it counted: its unrecognised hashes were “unknown”, not “ghost”. Reading the ghost count once warm found none, and the panel printed 0.0% never seen for twelve seconds.",
    silent:
      "A zero looks like a reading. It is the product’s claim made backwards, and it stood on the panel with the same authority as a true one.",
    caught:
      "A test that walks the calibration block by block and asserts null, not zero, until a block has actually been classified.",
    where: "lib/readout.ts · tests/calibration.test.ts",
  },
  {
    title: "A green dot reading LIVE over a PRNG",
    showed:
      "The status indicator said live while every figure on the page came from a seeded generator. The name of the active source existed only in a console.log behind a debug flag.",
    silent:
      "Health and provenance are different questions, and the dot answered the first. The stream was healthy. It was also not Ethereum.",
    caught:
      "Reading the page as a stranger would. The dot now says simulated data and the About plate says it again in words.",
    where: "components/StatusIndicator.tsx · components/About.tsx",
  },
  {
    title: "A range band from two blocks",
    showed:
      "The spread under the headline figure was a min/max over however many blocks had been classified. Measured over 600 generated blocks whose true spread is 30 points, two samples recover 33% of it, five recover 64%, twelve recover 82%.",
    silent:
      "A narrow band does not read as thin evidence. It reads as a stable figure, which is a claim about Ethereum that nobody measured. And the band widens so slowly that nothing announces the earlier picture was wrong.",
    caught:
      "Running the estimator against the generator at every sample count. The band now waits for twelve blocks and is labelled with the count it was built from.",
    where: "lib/readout.ts",
  },
  {
    title: "A block shuffled for realism",
    showed:
      "The generator interleaved private flow into the block with a Fisher–Yates shuffle, which spread it correctly and destroyed the fee ordering of everything.",
    silent:
      "The block column shares its top, bottom and extent with the chamber, whose vertical axis is the priority fee. Next to it, the block’s vertical axis meant nothing, and nothing on screen said so.",
    caught:
      "Two adjacent rows 0.18 gwei out of sequence, noticed while checking a different thing. The block is now sorted by tip, and private flow is placed by resampling the tips it sits among.",
    where: "lib/stream/synthetic.ts",
  },
  {
    title: "An axis labelled with the wrong quantity",
    showed:
      "The chamber’s note said “height = fee offered”. Heights were computed from the effective priority fee, a different number that mostly would not fit on the axis.",
    silent:
      "Both are fees, both are in gwei, and the picture looked the same under either caption.",
    caught:
      "Six live marks read against the axis: offers ran 12 to 31 gwei while the axis spanned 0.1 to 12.4. The height tracked the priority fee every time.",
    where: "components/Instrument.tsx · lib/fees.ts",
  },
  {
    title: "A rank held by a number that had stopped being true",
    showed:
      "Each mark cached its priority fee when it appeared, and the quota that keeps the highest bids on screen ranked by that cache. Legacy transactions bid a single gas price, so their priority fee moves every time the base fee does. The quota did not.",
    silent:
      "Every mark sat at the height its live fee put it, so the picture was consistent with itself. Only the choice of which marks were on screen at all was made from stale numbers, and an absence has no pixels.",
    caught:
      "A test that moves the base fee one step and asserts the reservation follows the new order. It did not, and the cache went. Every rank now asks the fee at the moment it is compared.",
    where: "lib/canvas/world.ts",
  },
  {
    title: "Two thirds of the pool on one row",
    showed:
      "Every transaction offering nothing above the base fee landed on the same bottom pixel row of the axis, a dense line that read as the floor of the scale.",
    silent:
      "The axis is logarithmic and clamps; nothing tells a clamp that most of its input has hit the stop. The line looked like an edge of the instrument, not like data.",
    caught:
      "Counting the recording: 65.8% of pending transactions at or under the floor, and 12% of those included against 78% of the rest. That population is a category, not a height. It now has a band of its own, and the axis starts above it.",
    where: "lib/canvas/layout.ts · lib/canvas/world.ts",
  },
  {
    title: "A fix aimed at the wrong reading",
    showed:
      "BASE FEE, in the panel, wrapped onto two lines at 1424 px. The obvious cause was a reading added the same day, and removing it would have looked like a repair.",
    silent:
      "The column was 143.6 px wide with or without that reading; the wrap came from the legends and the group widths. Taking the reading out would have left the wrap one resize away, with the story already closed.",
    caught:
      "Measuring the column before removing anything. The legends no longer wrap, the groups are rebalanced, and the panel was checked at 1280, 1424 and 1536 for text that touches.",
    where: "components/Instrument.tsx · app/globals.css",
  },
  {
    title: "A governor that watched the average and missed the stutter",
    showed:
      "On an emulated phone with the CPU held at a sixth of its speed, the field dropped two frames a second, 40 to 107 ms each, while the render budget stayed exactly where it started.",
    silent:
      "The governor judged a window by its mean frame rate, and the mean was 67 fps: twenty-seven fast frames absorb one slow one. Nothing it measured could see the frame a reader sees.",
    caught:
      "Recording every frame’s duration instead of their average. The slowest frame per window now reaches the governor beside the mean, and either one trips it; the same run cuts the budget by a third within twenty seconds.",
    where: "lib/capability.ts · lib/canvas/engine.ts",
  },
  {
    title: "A condition that could never be false",
    showed:
      "The first draft of that fix also demanded “no stutter” before giving capacity back. The tests passed. So did the test with that clause deleted.",
    silent:
      "The clause sat in an else branch that the stutter check above it had already excluded. Reachable in the reading, unreachable in the running; a mutant is the only reader that notices.",
    caught:
      "Mutation testing: the mutant survived, which meant the code it removed did nothing. The clause went, and the comment now says why the guard is implicit.",
    where: "lib/capability.ts",
  },
  {
    title: "A bar waiting for something that was not coming",
    showed:
      "During warm-up the calibration bar read “waiting for the pool snapshot · block 1/5 without it”.",
    silent:
      "It was true of the generator and of the first fake ingest, both of which send one. The real ingest, by decision, never does, and the recording was captured from one that did not. The words were inherited, not checked.",
    caught:
      "A screenshot taken for a different reason. The bar now counts blocks, and the prop that made it promise a snapshot stays for a source that can keep the promise.",
    where: "components/CalibrationBar.tsx · components/Instrument.tsx",
  },
  {
    title: "A fix undone by the tool meant to undo a mutant",
    showed:
      "Nothing on the screen: a working tree in which the governor fix above had quietly reverted to the version from three weeks earlier.",
    silent:
      "To measure the old behaviour against the new, the fix was mutated with sed and then restored with git checkout, which, in a tree where nothing is committed, restores the last commit, not the last edit. The tests were green before and after, on different code.",
    caught:
      "A grep for the new constant, done out of habit before the next run, found nothing. The fix was rebuilt from its own notes and re-verified from zero; the rule since is that a mutant is undone with the inverse edit, never with checkout.",
    where: "lib/capability.ts",
  },
  {
    title: "A recording that lost four blocks and looked complete",
    showed:
      "A fresh five-minute recording: twenty-one blocks, real transactions, every block whole. Played back, nothing on screen suggested that twenty-five had landed.",
    silent:
      "The capture retried a failed request but not a successful one with the wrong answer: a public gateway serves a fresh head from an upstream a block behind, whose receipts are missing for some hashes. That parses to nothing, and “nothing” was logged as a bad shape and dropped, four times in five minutes.",
    caught:
      "Counting the block numbers in the file against the first and last, which the recording itself records. The parse now sits inside the retry; the next capture kept all twenty-five.",
    where: "scripts/capture-replay.mjs",
  },
  {
    title: "A build gate that read the lines it expected",
    showed:
      "“✓ Compiled successfully”, printed at the end of every check for several hours, while the production build had been failing since the live feed’s route handlers were added.",
    silent:
      "The gate piped the build’s output through a filter for “error”, “Failed” and the success line. The build compiled, then died two steps later on “⨯ Invalid segment configuration export”, a route exporting maxDuration as an imported constant where the framework requires a literal, and that line contains none of the three words. The exit code was never read.",
    caught:
      "Trying to start the production server for a screen recording: no BUILD_ID. The route exports a literal now, a test holds it equal to the constant the stream limit derives from, and a gate is its exit code. The output is for reading, not for deciding.",
    where: "app/api/[endpoint]/route.ts · the verification rig",
  },
  {
    title: "A status endpoint describing a process that was not there",
    showed:
      "First deployment. The stream delivered frames and the page went live; /api/state, asked the same second, reported running: false and zero starts, and the panel’s COVERAGE reading stayed blank.",
    silent:
      "The three paths were three route files, and on this platform a route file is its own function with its own instance. The core lives in module state. The stream’s function had one; the state’s function had never started one, and answered truthfully about the wrong process. Locally, where everything is one process, the three had always agreed.",
    caught:
      "Reading /api/state and /api/stream from outside within the same minute and noticing they could not both be true. One dynamic route now serves the three paths from one function.",
    where: "app/api/[endpoint]/route.ts",
  },
];

/**
 * The three numbers the ingest's design said to publish before the feed is
 * called live: what it hears, how much of a block
 * it had heard first, and whether every head became a block. Measured, dated,
 * and replaced by the host's own figures once the site runs there.
 */
const MEASURED: readonly { figure: string; value: string; how: string }[] = [
  {
    figure: "Announced",
    value: "12 to 14 transactions a second",
    how: "11.9/s over a five-minute probe of the feed; 14.3/s over a twenty-minute run of the ingest (16,850 in 1,175 s). Mainnet as one public endpoint hears it, not as the chain produces it.",
  },
  {
    figure: "Coverage",
    value: "about half of a block heard before it landed",
    how: "55.5% over fifteen blocks in the probe; 47% to 56% across the day’s runs by the ingest’s own count, block by block. A second feed with three times the announcements added one point, so what is left unheard is mostly private flow, not deafness. From the host, on its first day: 42% to 61% block by block.",
  },
  {
    figure: "Blocks",
    value: "every head became a block",
    how: "97 of 97 over twenty minutes, receipts had for all, none missed, none invented; one link event, the opening one. Later runs: 12 of 12, 7 of 7. From the host: 12 of 12.",
  },
  {
    figure: "The stream limit",
    value: "one reconnect, no block lost",
    how: "The host closes a streamed response at 300 s, so the ingest ends each stream at 290 s and the page reconnects with the id of the last frame it saw. A page left open for 340 s on the deployed site: live at 59 s, reconnecting at 290 s, live again at 291 s. Its block height ran from 25,905,061 to 25,905,088, twenty-eight values, none skipped, none repeated.",
  },
];

const RULES: readonly { rule: string; detail: string }[] = [
  {
    rule: "Everything is measured in pixels before and after a change.",
    detail:
      "Luminance on a scanline, contrast ratios, widths of panel groups. Nothing is adjusted by eye, because eyes are what every failure below got past.",
  },
  {
    rule: "Zero is a claim.",
    detail:
      "Without enough data the instrument shows —, not a value. The headline figure is null until a block has been classified, and every figure derived from it inherits the null.",
  },
  {
    rule: "Nothing is drawn that the data does not support.",
    detail:
      "The range band waits for twelve blocks. The fee axis waits for 256 samples before it places a tick. Private flow is not marked until the pool has been watched for five blocks or seeded from a snapshot.",
  },
  {
    rule: "A green test with no dead mutant is not evidence.",
    detail:
      "The source is mutated to check that the test fails, and fails for the right reason. One solver below survived every mutation, which is how its fallback was found to be hiding it.",
  },
  {
    rule: "Measured and inferred are kept apart.",
    detail:
      "The panel says “never seen by this feed”, not “never in the mempool”, because the second is a statement about the network and the first is what was recorded.",
  },
];

export default function NotesPage() {
  return (
    <main className="df-about df-notes">
      <Link href="/" className="df-about-link">
        ← Instrument
      </Link>

      <h1 className="df-legend df-about-eyebrow df-notes-title">
        Notes on method
      </h1>

      <p>
        Darkflow was built against a synthetic generator before it read
        Ethereum, so that when the data became real nothing on the screen
        would need to be taken on trust. Five working rules, and then the list
        that produced them.
      </p>

      <ol className="df-notes-rules">
        {RULES.map(({ rule, detail }) => (
          <li key={rule}>
            <strong>{rule}</strong> {detail}
          </li>
        ))}
      </ol>

      <h2 className="df-legend df-about-eyebrow df-about-eyebrow--later">
        Failures that looked right
      </h2>

      <p>
        The characteristic failure of this project is one that cannot be seen,
        because it produces a plausible picture. None of the entries below was
        reported by a viewer; each was found by measuring something that looked
        fine. For each: what the screen showed, why nothing flagged it, and how
        it was caught.
      </p>

      <ol className="df-notes-failures">
        {FAILURES.map((failure, index) => (
          <li key={failure.title}>
            <h3>
              <span className="df-notes-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              {failure.title}
            </h3>
            <dl>
              <dt>Showed</dt>
              <dd>{failure.showed}</dd>
              <dt>Silent because</dt>
              <dd>{failure.silent}</dd>
              <dt>Caught by</dt>
              <dd>{failure.caught}</dd>
            </dl>
            <span className="df-notes-where">{failure.where}</span>
          </li>
        ))}
      </ol>

      <h2 className="df-legend df-about-eyebrow df-about-eyebrow--later">
        What the feed measured
      </h2>

      <p>
        The numbers the feed had to produce before it could be called live.
        Measured on 2026-09-03 from a development machine running the same
        core the site runs, then on 2026-09-04 from the host itself, the day
        it went up.
      </p>

      <dl className="df-notes-measured">
        {MEASURED.map(({ figure, value, how }) => (
          <Fragment key={figure}>
            <dt>{figure}</dt>
            <dd>
              <strong>{value}</strong> {how}
            </dd>
          </Fragment>
        ))}
      </dl>

      <h2 className="df-legend df-about-eyebrow df-about-eyebrow--later">
        Open
      </h2>

      <ul className="df-about-list">
        <li>
          <strong>Sibling instances.</strong> The ingest runs inside the
          site&rsquo;s own route handler: one subscription to a public
          endpoint, shared by every open page, started when the first one
          arrives and dropped a minute after the last one leaves. The host,
          though, may run more than one copy of that handler at once, and on
          the first day it did: a page&rsquo;s stream and its coverage poll
          were answered by different copies, each with its own subscription.
          The stream is right either way. The COVERAGE reading can describe
          the copy next door, and the fix, carrying coverage inside the stream
          itself, is not done.
        </li>
        <li>
          <strong>The propagation term.</strong> How much of the public mempool
          this feed fails to hear before it lands is the largest source of error
          in the headline figure. It is now measured continuously: the ingest
          counts, for every block, how many rows it had announced first, and
          the panel shows the share as COVERAGE. It was also measured once
          against a second feed with three times the announcements, which added
          one point. What it has not been measured against is an independent
          record of the pool itself, which no public endpoint offers.
        </li>
        <li>
          <strong>Small screens.</strong> Below 1024px the instrument is laid
          out for a phone rather than shrunk from a desk: the canvas takes
          portrait proportions, the panel stacks, a tapped row opens the
          inspector as a sheet, the axis numerals thin themselves to the
          chamber&rsquo;s height. Measured in emulation at 390, 430, 768 and
          sideways at 844&times;390. What remains unmeasured is a real
          phone&rsquo;s GPU and compositor, which no emulation approximates.
        </li>
      </ul>
    </main>
  );
}
