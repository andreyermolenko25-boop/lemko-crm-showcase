# syntax=docker/dockerfile:1

# Next.js 16 (App Router) + pnpm — multi-stage production image.
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare pnpm@9.15.9 --activate \
  && pnpm install --frozen-lockfile

FROM base AS builder
RUN corepack prepare pnpm@9.15.9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
