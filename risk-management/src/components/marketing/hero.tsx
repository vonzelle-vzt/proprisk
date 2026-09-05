import Link from 'next/link';

export function MarketingHero() {
  return (
    <section className="mx-auto max-w-5xl px-6 pt-20 pb-16 text-center">
      <p className="mb-4 text-sm font-medium uppercase tracking-wider text-red-400">
        Risk management for prop-trading firms
      </p>
      <h1 className="text-4xl font-bold leading-tight text-white sm:text-5xl md:text-6xl">
        The risk desk that <span className="text-red-500">publishes its prices</span>.
      </h1>
      <p className="mx-auto mt-6 max-w-2xl text-lg text-gray-300">
        Connect your own trading platform, configure rules from the presets your competitors already
        run, prove the switch is safe before you enforce it, and get a payout dispute-grade evidence
        pack for every decision. Every tier below has a number on it.
      </p>
      <div className="mt-10 flex items-center justify-center gap-4">
        <Link
          href="/signup"
          className="rounded-xl border border-red-500/50 bg-red-600 px-6 py-3 text-base font-medium text-white shadow-lg shadow-red-500/20 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:ring-offset-2 focus:ring-offset-background"
        >
          Start free
        </Link>
        <Link
          href="/pricing"
          className="rounded-xl border border-white/20 bg-white/10 px-6 py-3 text-base font-medium text-gray-200 hover:bg-white/20"
        >
          See pricing
        </Link>
      </div>
    </section>
  );
}
