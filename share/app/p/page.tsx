import Link from "next/link";

export default function ShareIndexPage() {
  return (
    <main className="share-app">
      <header className="share-top">
        <div>
          <p className="eyebrow">opencloud</p>
          <h1>Shared projects</h1>
        </div>
      </header>
      <p className="banner">
        This address needs the project slug, like <Link href="/p/preview-check-ntja4r">/p/preview-check-ntja4r</Link>.
        Copy it from the office Share panel.
      </p>
    </main>
  );
}
