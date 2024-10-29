# Modified Dockerfile from https://github.com/directus/directus > Dockerfile

FROM node:20-alpine AS builder

# upgrade packages, prepare pnpm, git, and env
RUN apk upgrade --latest --prune --purge --no-cache \
	&& apk add --update --no-cache 'git=~2'

# set workdir
WORKDIR /directus

# clone directus repository
ENV DIRECTUS_VERSION=v11.1.0
RUN git clone --depth 1 --single-branch --branch ${DIRECTUS_VERSION} \
	https://github.com/directus/directus.git ./ \
	&& rm -rf .git/

RUN rm -rf ./api/src/app.ts package.json pnpm-lock.yaml

COPY ./api/src/app.ts ./api/src

# build directus

ENV NODE_OPTIONS=--max-old-space-size=8192

RUN <<EOF
  if [ "$TARGETPLATFORM" = 'linux/arm64' ]; then
  	apk --no-cache add python3 build-base
  	ln -sf /usr/bin/python3 /usr/bin/python
  fi
EOF

COPY package.json .
RUN corepack enable && corepack prepare

COPY pnpm-lock.yaml .
RUN pnpm fetch

RUN <<EOF
	pnpm install --recursive --offline --frozen-lockfile
	npm_config_workspace_concurrency=1 pnpm run build
	pnpm --filter directus deploy --prod dist
	cp ./ecosystem.config.cjs ./dist/
	cd dist
	echo 'node cli.js bootstrap && node cli.js start' > run.sh
	chmod +x ./run.sh
	# Regenerate package.json file with essential fields only
	# (see https://github.com/directus/directus/issues/20338)
	node -e '
		const f = "package.json", {name, version, type, exports, bin} = require(`./${f}`), {packageManager} = require(`../${f}`);
		fs.writeFileSync(f, JSON.stringify({name, version, type, exports, bin, packageManager}, null, 2));
	'
	mkdir -p database extensions uploads
EOF

# main image
FROM node:20-alpine AS final

RUN apk upgrade --latest --prune --purge --no-cache \
	&& NODE_ENV=production


WORKDIR /directus

EXPOSE 8055
HEALTHCHECK NONE

USER node
COPY --from=builder --chown=node:node /directus/dist .


CMD ["/bin/sh", "-x", "/directus/run.sh"]

