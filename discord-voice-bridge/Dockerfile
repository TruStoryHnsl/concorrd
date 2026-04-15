FROM node:22-bookworm-slim
WORKDIR /app
# Build tools needed for @discordjs/opus native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ cmake \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
CMD ["npm", "start"]
