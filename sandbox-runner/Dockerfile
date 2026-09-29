# Sandbox container image for Factory agent runs.
# Based on the Cloudflare Sandbox SDK base image (tag must match the
# @cloudflare/sandbox package version in package.json — 0.12.9), plus the tools
# an agent needs to work a ticket: git (clone/commit/push) and gh (open PRs).
FROM docker.io/cloudflare/sandbox:0.12.9

# gh (GitHub CLI) for PR creation; git is already present in the base image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Each job gets its own container and unprivileged Codex or Claude Code process.
ENV DISABLE_AUTOUPDATER=1
RUN npm install -g @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.284 \
  && useradd --uid 10001 --create-home --shell /bin/bash factory \
  && mkdir -p /workspace \
  && chmod 1777 /workspace
COPY scripts/*.mjs /opt/factory/
EXPOSE 3000
