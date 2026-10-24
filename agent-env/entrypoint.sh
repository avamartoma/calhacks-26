#!/bin/sh
set -eu

if [ -z "${ENV_TOKEN:-}" ]; then
  echo "ENV_TOKEN is required" >&2
  exit 1
fi

if [ -n "${GIT_TOKEN:-}" ]; then
  cat > /tmp/git-askpass.sh << 'EOF'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "x-access-token" ;;
  *) printf '%s\n' "$GIT_TOKEN" ;;
esac
EOF
  chmod 700 /tmp/git-askpass.sh
  export GIT_ASKPASS=/tmp/git-askpass.sh
  export GIT_TERMINAL_PROMPT=0
fi

if [ -n "${REPO:-}" ]; then
  if [ -z "${BRANCH:-}" ]; then
    echo "BRANCH is required when REPO is set" >&2
    exit 1
  fi
  case "$REPO" in
    https://*) ;;
    *)
      echo "REPO must be an https URL" >&2
      exit 1
      ;;
  esac
  rm -rf /workspace
  git clone "$REPO" /workspace
  cd /workspace
  git checkout -B "$BRANCH"
  git config user.email "agent@iteration1.local"
  git config user.name "Iteration 1"
else
  mkdir -p /workspace
fi

exec node /opt/agent-env/dist/server.js
