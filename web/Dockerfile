# Stage 1: Build React client
FROM node:25-alpine AS build
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ .
RUN npm run build

# Stage 2: Serve via Caddy
FROM caddy:alpine
COPY --from=build /app/dist /srv/html
EXPOSE 8080 8443
