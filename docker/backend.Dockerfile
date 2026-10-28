# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci

FROM deps AS build
COPY tsconfig.base.json ./
COPY shared ./shared
COPY backend ./backend
RUN npm run build --workspace=shared
RUN npm run prisma:generate --workspace=backend
RUN npm run build --workspace=backend

FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci --omit=dev --workspace=backend --workspace=shared
COPY --from=build /app/node_modules/@prisma /app/node_modules/@prisma
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
# The prisma CLI (devDependency, so prod-deps' --omit=dev skips it) plus
# the schema/migrations folder it needs — neither is required to run the
# app itself, but without them there's no way to apply a new migration
# against a deployed container short of rebuilding from the `build` stage
# each time. Pulled from `deps` (full npm ci, dev included) rather than
# reinstalling, and from `build` (already has backend/prisma/ via its own
# `COPY backend ./backend`) respectively — no extra install step.
COPY --from=deps /app/node_modules/prisma ./node_modules/prisma
COPY --from=deps /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=build /app/backend/prisma ./backend/prisma
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/package.json
EXPOSE 3000
CMD ["node", "backend/dist/index.js"]
