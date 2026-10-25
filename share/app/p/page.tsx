import { OpenLink } from "@/components/OpenLink";

export default function ShareIndexPage() {
  return (
    <main className="share-app">
      <header className="share-top">
        <div>
          <p className="eyebrow">opencloud</p>
          <h1>Shared projects</h1>
        </div>
      </header>
      <p className="banner">This address needs the rest of the share link. Paste the whole link you were sent.</p>
      <OpenLink />
    </main>
  );
}
