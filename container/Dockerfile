FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    chromium \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium env for puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy agent-runner
COPY agent-runner/package.json agent-runner/package-lock.json* ./
RUN npm install --production

COPY agent-runner/dist/ ./dist/

# Create workspace directory
RUN mkdir -p /workspace /ipc

ENTRYPOINT ["node", "dist/index.js"]
