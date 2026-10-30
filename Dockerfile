FROM node:26-alpine AS builder

WORKDIR /app

RUN apk add --no-cache ca-certificates

RUN npm install --global corepack && corepack enable

COPY .yarn .yarn
COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/api/tsconfig*.json packages/api/
COPY packages/cli/tsconfig.json packages/cli/tsconfig.json

RUN yarn --immutable

COPY packages/ui packages/ui
COPY packages/api packages/api

RUN cd packages/ui && \
    npx generate-openapi-client && \
    yarn build

RUN cd packages/api && \
    yarn build

RUN yarn workspaces focus @zyno-io/pixelci-api --production

###

FROM node:26-alpine
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache tini

COPY --from=builder /app/packages/api .
COPY --from=builder /app/node_modules node_modules
COPY LICENSE.md THIRD-PARTY-LICENSES.md ./

ARG BUILD_VERSION
RUN if [ -n "${BUILD_VERSION}" ]; then npm version "${BUILD_VERSION}" --allow-same-version; fi

ENTRYPOINT ["/sbin/tini", "--"]
CMD [ "node", ".", "server:start" ]
