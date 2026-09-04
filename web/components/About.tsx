import Link from "next/link";
import { ReadingKey } from "@/components/ReadingKey";
import { activeSourceName } from "@/lib/stream";

/**
 * What the number means, and what it cannot mean.
 *
 * Short paragraphs under the instrument, in the type already on the page: the
 * legend face for the headings, the body face at reading size, and the mono
 * numerals where a figure appears. No new type, no new colour, nothing that
 * competes with the chamber above it.
 *
 * The second section exists because the first one used to overclaim. The
 * apparatus watches the mempool from one node and reports what that node never
 * saw pending; the prose said "the public mempool never saw it", which is a
 * statement about the network and not one this instrument can make. The
 * headline figure is an upper bound on private flow from one vantage point, and
 * the page has to say so in the same voice it uses to say everything else —
 * measured where measured, inferred where inferred.
 *
 * The last paragraph exists because of what the page would otherwise be doing:
 * explaining private order flow, in confident prose, over a seeded PRNG. The
 * status indicator says `simulated data` rather than `live`, and this says the
 * same thing in words, because a reader who scrolls past the dot has to meet it
 * again here.
 */
export function About() {
  const sourceName = activeSourceName();
  const simulated = sourceName === "synthetic";
  const recorded = sourceName === "replay";

  return (
    <section id="about" className="df-about">
      <ReadingKey />

      <h2 className="df-legend df-about-eyebrow df-about-eyebrow--later">
        What this measures
      </h2>

      <p>
        An Ethereum transaction is normally announced before it is settled. It
        is broadcast to the public mempool, where it waits among tens of
        thousands of others while builders decide what to include. Anyone
        running a node can watch that queue. It is the left of this screen:
        every mark is one transaction still waiting, placed by the fee it is
        offering.
      </p>

      <p>
        Every twelve seconds a block is built, and some of what appears in it
        never went through that queue, not as this feed saw it. It went
        straight to a builder, through a private relay or inside a bundle, and
        was public for the first time when the block was. Those transactions
        cannot fly in from the left, because they were never anywhere: they
        appear in place, and they are the only warm colour on the screen.
      </p>

      <p>
        The share matters because the mempool is the part of Ethereum that is
        observable in advance. A transaction that skips it cannot be front-run,
        which is often exactly why it skipped. It also cannot be seen,
        priced, or argued with until it is already final. The figure above is
        how much of one block this feed never saw coming.
      </p>

      <h2 className="df-legend df-about-eyebrow df-about-eyebrow--later">
        What it cannot tell apart
      </h2>

      <p>
        &ldquo;Never seen&rdquo; is a statement about one vantage point, not
        about the network. Four things land in the same count as private flow,
        and the instrument cannot separate them:
      </p>

      <ul className="df-about-list">
        <li>
          <strong>Propagation.</strong> A single node sees most of the public
          mempool, not all of it. A transaction that reached other nodes but
          not this one before it landed is counted here as never seen. This is
          the largest source of error, and it is not measured yet.
        </li>
        <li>
          <strong>Memory.</strong> A hash is remembered for five minutes. A
          transaction that waited longer than that and then landed is counted
          as never seen, although it was public the whole time.
        </li>
        <li>
          <strong>The cold start.</strong> Nothing is classified until the pool
          has been watched for five blocks, or seeded from a snapshot of it.
          Until then the figure is blank, not zero, because zero would be a
          claim.
        </li>
        <li>
          <strong>Reorgs.</strong> When the chain replaces a block, the
          replacement is classified on its own and the orphaned block is
          withdrawn from the record, so a transaction that lands twice is not
          counted twice.
        </li>
      </ul>

      <p>
        So the figure is an upper bound on private flow as seen from here, with
        the first term unquantified. Measured against an independent record,
        a second node or a public mempool archive, it would become an
        estimate. It has not been.
      </p>

      <p>
        <Link href="/notes" className="df-about-link">
          How this was verified → Notes on method
        </Link>
      </p>

      {recorded ? (
        <p className="df-about-note">
          <strong>This page is replaying a recording.</strong> Every
          transaction and block on it is real, captured from Ethereum mainnet
          through public RPC endpoints. The panel says when, and which
          blocks. It plays at the pace it was recorded and starts over when it
          ends. What is not real is the clock: a block that landed one
          afternoon lands again now, with every age exactly as it was. This
          build was set to play the recording; the live feed is a build away.
        </p>
      ) : null}

      {simulated ? (
        <p className="df-about-note">
          <strong>This page is not showing Ethereum.</strong> This build runs
          without the live feed, so every figure here comes from a synthetic
          generator built to have the shape of real traffic: long-tailed fees,
          twelve-second blocks, transactions that were never announced. It is
          there so the instrument can be built and judged before the data is
          real. Nothing on this page is a measurement of the chain.
        </p>
      ) : null}
    </section>
  );
}

export default About;
