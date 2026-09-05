/**
 * /e/<CODE> - one specific mixer, by its own permanent code.
 *
 * The club link at the root follows whatever was published last; this address
 * never moves, so an old day can still be looked up after the next one has
 * replaced it. Both render the same three tabs.
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

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventView id={id.toUpperCase()} />;
}
