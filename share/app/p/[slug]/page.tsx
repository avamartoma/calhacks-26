import { ProjectScreen } from "@/components/ProjectScreen";

export default async function Page({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const resolved = "then" in params ? await params : params;
  return <ProjectScreen slug={resolved.slug} />;
}
