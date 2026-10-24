import Link from "next/link";

export default function HomePage() {
  return (
    <main className="share-app">
      <header className="share-top">
        <div>
          <p className="eyebrow">Iteration1</p>
          <h1>Shared projects</h1>
        </div>
      </header>
      <p className="banner">Open a project at <Link href="/p/your-slug">/p/your-slug</Link>.</p>
    </main>
  );
}
