/**
 * /e/<CODE> - one specific mixer, by its own permanent code.
 *
 * The club link at the root follows whatever was published last; this address
 * never moves, so an old day can still be looked up after the next one has
 * replaced it. Both render the same three tabs.
 *
 * `?tab=board` opens on the leaderboard, which is how the results archive links
 * to a finished tournament. Read here on the server and passed down as a prop
 * rather than with `useSearchParams`, so the tab is right in the first paint
 * and the view needs no Suspense boundary around it.
 */
import EventView from "@/app/EventView";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return {
    title: `Tennis mixer · ${id.toUpperCase()}`,
    description: "Schedule, results and leaderboard.",
  };
}

const TABS = ["schedule", "results", "board"] as const;
type Tab = (typeof TABS)[number];

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const initialTab = TABS.find((t) => t === tab) as Tab | undefined;
  return <EventView id={id.toUpperCase()} initialTab={initialTab} />;
}
