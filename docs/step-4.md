# Step 4 — Share link

## Route

The share app is a Next.js App Router project in `share/`.

- Project page: `/p/[slug]` implemented by `share/app/p/[slug]/page.tsx`
- Local dev, from `share/`: `npx next dev -p 4315`

Deploy the `share` directory on Vercel. A shared project is then `https://<deployment>/p/<shareSlug>`.

On load the page calls `sharing.get({ slug })`. Sign-in does not block that call. If an Auth0 ID token is already available, `ConvexHttpClient.setAuth` runs with that ID token before the Convex calls. As soon as `get` returns a `projectId`, the page calls `sessions.resume({ projectId })`. A public project resumes without waiting for sign-in. The page then polls `sessions.get({ sessionId })` and `events.byProject({ projectId })` every 2 seconds. A live preview is an iframe keyed by `previewUrl`. Until then, `snapshotUrl` is shown as an image.

## Environment

Copy `share/.env.example` to `share/.env.local`.

- `NEXT_PUBLIC_CONVEX_URL` — Convex URL. Local default `http://127.0.0.1:3210`.
- `NEXT_PUBLIC_AUTH0_DOMAIN` — Auth0 tenant domain, with no path.
- `NEXT_PUBLIC_AUTH0_CLIENT_ID` — Auth0 public client id.

Auth0 is a public PKCE client. Do not put a client secret in the share app. The page sends the Auth0 ID token (audience is the client id, and the token contains email). It does not send an opaque access token. Leave the API audience unset.

In the Auth0 application, allow the share origin as a web origin, logout URL, and callback URL. Sign-in redirects back to `/p/[slug]`, so allow `http://127.0.0.1:4315/p/<slug>`, `http://localhost:4315/p/<slug>`, and the same path on the deployed host.

The office panel reads `VITE_CONVEX_URL` or `http://127.0.0.1:3210` and calls Convex unsigned. That is the offline local owner.

## Office mount

When a non-demo project is open, render:

```tsx
<SharePanel projectId={room.preview?.projectId} shareSlug={...} />
```

`SharePanel` is exported from `src/SharePanel.tsx`. Pass `projectName={room.name}` when the room name should show before Convex returns one.
