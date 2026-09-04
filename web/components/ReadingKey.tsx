/**
 * The reading key: the four channels, each with a specimen.
 *
 * Every instrument carries a key on its case, engraved, saying what its scale
 * means. This one had the information in the region notes across the head of
 * the chamber — "height = priority fee", "fades as it waits" — and nowhere
 * else, which is where it is useful while you are reading the field and
 * useless when you have stopped to ask what the picture is. The key sits at
 * the head of the plate under the instrument, where a reader who scrolls to
 * ask "what am I looking at" arrives.
 *
 * Specimens, not icons. Each is a small drawing in the instrument's own
 * tokens: the marks are the field's marks at their own radius (scaled up by
 * a third, because a key is a legend and is read at reading distance), the
 * rows are the block's rows, the track is the track. Nothing here is a
 * picture *of* the instrument; it is a piece of it, cut out and labelled.
 *
 * One rule per row, in the same order the eye meets them on screen: the
 * field first, then what happens to it.
 */

type Channel = {
  channel: string;
  reading: string;
  note: string;
  specimen: React.ReactNode;
};

/** Field marks at their radius, scaled up by a third for reading distance. */
const R = 2.5;

const CHANNELS: readonly Channel[] = [
  {
    channel: "Height and brightness",
    reading: "priority fee",
    note: "The more a transaction offers, the higher it sits and the brighter it burns. The axis is logarithmic and rescales with the market.",
    specimen: (
      <svg viewBox="0 0 72 24" aria-hidden="true">
        <line x1="4" y1="20.5" x2="68" y2="20.5" className="df-key-rule" />
        <line x1="4" y1="12.5" x2="68" y2="12.5" className="df-key-rule" />
        <line x1="4" y1="4.5" x2="68" y2="4.5" className="df-key-rule" />
        <circle cx="16" cy="19" r={R} style={{ fill: "var(--t-0)" }} />
        <circle cx="32" cy="14" r={R} style={{ fill: "var(--t-1)" }} />
        <circle cx="46" cy="9" r={R} style={{ fill: "var(--t-3)" }} />
        <circle cx="60" cy="5" r={R} style={{ fill: "var(--t-core)" }} />
      </svg>
    ),
  },
  {
    channel: "The floor band",
    reading: "at base fee",
    note: "Below the lowest rule is the band: transactions offering nothing above the base fee. In every mainnet recording so far that is most of the pool. A mark's height inside it means nothing. How full it is does.",
    specimen: (
      <svg viewBox="0 0 72 24" aria-hidden="true">
        <line x1="4" y1="6.5" x2="68" y2="6.5" className="df-key-rule" />
        <line x1="4" y1="13.5" x2="68" y2="13.5" className="df-key-rule" />
        <circle cx="22" cy="4" r={R} style={{ fill: "var(--t-2)" }} />
        <circle cx="50" cy="10" r={R} style={{ fill: "var(--t-1)" }} />
        <circle cx="9" cy="18" r={R} style={{ fill: "var(--t-0)" }} />
        <circle cx="18" cy="20.5" r={R} style={{ fill: "var(--t-0)" }} />
        <circle cx="27" cy="17" r={R} style={{ fill: "var(--t-0)" }} />
        <circle cx="36" cy="20" r={R} style={{ fill: "var(--t-0)" }} />
        <circle cx="45" cy="18.5" r={R} style={{ fill: "var(--t-0)" }} />
        <circle cx="54" cy="20.5" r={R} style={{ fill: "var(--t-0)" }} />
        <circle cx="63" cy="17.5" r={R} style={{ fill: "var(--t-0)" }} />
      </svg>
    ),
  },
  {
    channel: "Fading",
    reading: "time waiting",
    note: "A mark dims the longer it waits, whatever it pays. Brightness is not age and age is not brightness: the two never share a channel.",
    specimen: (
      <svg viewBox="0 0 72 24" aria-hidden="true">
        <circle cx="12" cy="12" r={R} style={{ fill: "var(--t-3)", opacity: 1 }} />
        <circle cx="28" cy="12" r={R} style={{ fill: "var(--t-3)", opacity: 0.62 }} />
        <circle cx="44" cy="12" r={R} style={{ fill: "var(--t-3)", opacity: 0.38 }} />
        <circle cx="60" cy="12" r={R} style={{ fill: "var(--t-3)", opacity: 0.22 }} />
      </svg>
    ),
  },
  {
    channel: "Row width",
    reading: "gas used, on a root scale",
    note: "In the block, each transaction is a row as wide as the gas it consumed, against the largest in that block. Square root, so a rollup batch does not flatten every transfer onto the floor.",
    specimen: (
      <svg viewBox="0 0 72 24" aria-hidden="true">
        <line x1="8.5" y1="2" x2="8.5" y2="22" className="df-key-rule" />
        <rect x="9" y="3" width="59" height="4" style={{ fill: "var(--settled)" }} />
        <rect x="32" y="10" width="36" height="4" style={{ fill: "var(--settled)" }} />
        <rect x="47" y="17" width="21" height="4" style={{ fill: "var(--settled)" }} />
      </svg>
    ),
  },
  {
    channel: "Tone and track",
    reading: "seen, or never seen",
    note: "A line reaching a row is where that transaction came from in the mempool. A warm row has no line: this feed never saw it pending. That is the only thing the warm colour ever means here.",
    specimen: (
      <svg viewBox="0 0 72 24" aria-hidden="true">
        <line x1="6" y1="6" x2="44" y2="5" className="df-key-track" />
        <line x1="10" y1="17" x2="47" y2="19" className="df-key-track" />
        <rect x="44" y="3" width="24" height="4" style={{ fill: "var(--settled)" }} />
        <rect x="52" y="10" width="16" height="4" style={{ fill: "var(--ghost-settled)" }} />
        <rect x="47" y="17" width="21" height="4" style={{ fill: "var(--settled)" }} />
      </svg>
    ),
  },
];

export function ReadingKey() {
  return (
    <section className="df-key" aria-labelledby="df-key-title">
      <h2 id="df-key-title" className="df-legend df-about-eyebrow">
        Reading key
      </h2>
      <dl className="df-key-grid">
        {CHANNELS.map((c) => (
          <div key={c.channel} className="df-key-row">
            <div className="df-key-specimen">{c.specimen}</div>
            <dt>
              <span className="df-key-channel">{c.channel}</span>
              <span className="df-key-reading">{c.reading}</span>
            </dt>
            <dd>{c.note}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default ReadingKey;
