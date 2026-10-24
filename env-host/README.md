# Iteration 1 env host

One process on the Linux VM. `POST /envs` starts one `agent-env` container. `DELETE /envs/:id` removes it.

`ENV_HOST_MODE=docker` requires Docker and gVisor (`--runtime=runsc` on every `docker run`). This Windows checkout has no Docker, so local tests use `ENV_HOST_MODE=stub`, which returns a URL and does not start a container. Convex uses this host only when `SANDBOX_PROVIDER=env-host`. The default sandbox is E2B.

## Run on the VM

```sh
docker build -t agent-env ../agent-env
export ENV_HOST_SECRET=dev-secret
export PUBLIC_IP=<vm public ip>
export GIT_TOKEN=<optional github token>
npm install
npm run dev
```

On startup the host keeps `POOL_SIZE` idle containers (default 3) with no repo. `POST /envs` claims one and calls `POST /attach` on it, then starts a replacement in the background. The response waits until attach finishes, and the log line is `session <id> ready in <ms>ms via pool <url>`. An empty pool uses the cold `docker run` path and logs `via cold`. `DELETE /envs/:id` removes that container and does not put it back. `GET /pool` returns `{ idle, claimed }`.

The container API listens on port 3000. Dependencies are installed in the image build (`npm ci`, git), not at container start. The returned URL is `http://PUBLIC_IP:<port>`. The host calls the container on `127.0.0.1`.

`AGENT_ENV_TOKEN` is the bearer token inside the container. When it is unset, the host sends `ENV_HOST_SECRET`. `GIT_TOKEN`, when set, is passed through so the container can push to the origin repo.

`POST /envs`, `DELETE /envs/:id`, and `GET /envs` require `Authorization: <ENV_HOST_SECRET>`. `id` must be alphanumeric. `repoUrl` must be an https URL with no credentials. Commands are `docker` argument arrays, not a shell string.
