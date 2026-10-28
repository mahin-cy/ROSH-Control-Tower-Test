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
COPY frontend ./frontend
RUN npm run build --workspace=shared
RUN npm run build --workspace=frontend

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g serve@14
COPY --from=build /app/frontend/dist ./dist
EXPOSE 3000
CMD ["serve", "-s", "dist", "-l", "3000"]
