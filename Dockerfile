# syntax=docker/dockerfile:1.7

FROM node:24.14.0-alpine3.23@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.14.0-alpine3.23@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114 AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
# 3000 = 远端 MCP 服务（PORT，这是唯一需要接进 Service 的端口）。
# 3001 = 自建授权服务器（AUTH_PORT），同一个镜像里的另一个程序，
#        入口是 dist/auth.js。官网 OIDC 上线后它已停用，生产不部署——
#        所以部署时只需要暴露 3000。
EXPOSE 3000 3001
CMD ["node", "dist/http.js"]
