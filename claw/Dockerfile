FROM node:18-alpine

WORKDIR /app

# Install OpenClaw dependencies and setup
RUN apk add --no-cache git python3 make g++
RUN npm install -g openclaw-cli

# Copy volk-ai-claw plugin
COPY volk-ai-claw/ /app/volk-ai-claw/
RUN cd /app/volk-ai-claw && npm install --production

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose volk-ai-claw HTTP server port and OpenClaw gateway port
EXPOSE 18788
EXPOSE 18789

# Environment variables with defaults
ENV CLAW_TTL_SECONDS=0
ENV VOLK_AI_API_BASE_URL=""
ENV VOLK_AI_API_KEY=""
ENV OPENCLAW_GATEWAY_TOKEN=""

ENTRYPOINT ["/entrypoint.sh"]
