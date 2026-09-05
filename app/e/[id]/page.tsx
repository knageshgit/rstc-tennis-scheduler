import Scoreboard from "./Scoreboard";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return {
    title: `Scores - ${id.toUpperCase()}`,
    description: "Enter your court's score and see the leaderboard.",
  };
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Scoreboard id={id.toUpperCase()} />;
}
