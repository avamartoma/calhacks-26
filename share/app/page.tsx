import { OpenLink } from "@/components/OpenLink";

export default function HomePage() {
  return (
    <main className="share-app">
      <header className="share-top">
        <div>
          <p className="eyebrow">opencloud</p>
          <h1>Shared projects</h1>
        </div>
      </header>
      <p className="banner">Open a project someone shared with you. Nothing to install: it runs here in the browser.</p>
      <OpenLink />
    </main>
  );
}
