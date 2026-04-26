FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

# ffmpeg provides ffprobe + ffmpeg, used by the filesystem scanner to read
# audiobook metadata (title/author/chapters/duration) and extract cover art.
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/index.js"]
