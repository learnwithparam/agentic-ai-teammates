# One image for every process: the three world apps and Mission Control's five processes.
# deploy/docker-compose.yml starts each one with its own command. Settings come from the
# environment at run time; the image holds no secret and no .env.

FROM node:24.22.3-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY news/package.json news/package-lock.json ./news/
RUN npm ci --prefix news
COPY . .
RUN npm run build

FROM node:24.22.3-trixie-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps ./apps
COPY src ./src
COPY tsconfig.json ./
COPY --from=build /app/dist/client ./dist/client
COPY --from=build /app/news/dist ./news/dist
USER node
