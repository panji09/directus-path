import { useEnv } from '@directus/env';
import { InvalidPayloadError, ServiceUnavailableError } from '@directus/errors';
import { handlePressure } from '@directus/pressure';
import cookieParser from 'cookie-parser';
import type { Request, RequestHandler, Response } from 'express';
import express from 'express';
import type { ServerResponse } from 'http';
import { merge } from 'lodash-es';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'path';
import qs from 'qs';
import { registerAuthProviders } from './auth.js';
import activityRouter from './controllers/activity.js';
import accessRouter from './controllers/access.js';
import assetsRouter from './controllers/assets.js';
import authRouter from './controllers/auth.js';
import collectionsRouter from './controllers/collections.js';
import dashboardsRouter from './controllers/dashboards.js';
import extensionsRouter from './controllers/extensions.js';
import fieldsRouter from './controllers/fields.js';
import filesRouter from './controllers/files.js';
import flowsRouter from './controllers/flows.js';
import foldersRouter from './controllers/folders.js';
import graphqlRouter from './controllers/graphql.js';
import itemsRouter from './controllers/items.js';
import notFoundHandler from './controllers/not-found.js';
import notificationsRouter from './controllers/notifications.js';
import operationsRouter from './controllers/operations.js';
import panelsRouter from './controllers/panels.js';
import permissionsRouter from './controllers/permissions.js';
import policiesRouter from './controllers/policies.js';
import presetsRouter from './controllers/presets.js';
import relationsRouter from './controllers/relations.js';
import revisionsRouter from './controllers/revisions.js';
import rolesRouter from './controllers/roles.js';
import schemaRouter from './controllers/schema.js';
import serverRouter from './controllers/server.js';
import settingsRouter from './controllers/settings.js';
import sharesRouter from './controllers/shares.js';
import translationsRouter from './controllers/translations.js';
import { default as tusRouter, scheduleTusCleanup } from './controllers/tus.js';
import usersRouter from './controllers/users.js';
import utilsRouter from './controllers/utils.js';
import versionsRouter from './controllers/versions.js';
import webhooksRouter from './controllers/webhooks.js';
import {
	isInstalled,
	validateDatabaseConnection,
	validateDatabaseExtensions,
	validateMigrations,
} from './database/index.js';
import emitter from './emitter.js';
import { getExtensionManager } from './extensions/index.js';
import { getFlowManager } from './flows.js';
import { createExpressLogger, useLogger } from './logger/index.js';
import authenticate from './middleware/authenticate.js';
import cache from './middleware/cache.js';
import cors from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import extractToken from './middleware/extract-token.js';
import rateLimiterGlobal from './middleware/rate-limiter-global.js';
import rateLimiter from './middleware/rate-limiter-ip.js';
import sanitizeQuery from './middleware/sanitize-query.js';
import schema from './middleware/schema.js';
import { initTelemetry } from './telemetry/index.js';
import { getConfigFromEnv } from './utils/get-config-from-env.js';
import { Url } from './utils/url.js';
import { validateStorage } from './utils/validate-storage.js';

const require = createRequire(import.meta.url);

export default async function createApp(): Promise<express.Application> {
	const env = useEnv();
	const logger = useLogger();
	const helmet = await import('helmet');

	let basePath = ''
	let basePathUrl = ''
	if(env['BASE_PATH']){
		basePath = env['BASE_PATH'] as string
		basePathUrl = `/${env['BASE_PATH'] as string}`
	}

	await validateDatabaseConnection();

	if ((await isInstalled()) === false) {
		logger.error(`Database doesn't have Directus tables installed.`);
		process.exit(1);
	}

	if ((await validateMigrations()) === false) {
		logger.warn(`Database migrations have not all been run`);
	}

	if (!env['SECRET']) {
		logger.warn(
			`"SECRET" env variable is missing. Using a random value instead. Tokens will not persist between restarts. This is not appropriate for production usage.`,
		);
	}

	if (!new Url(env['PUBLIC_URL'] as string).isAbsolute()) {
		logger.warn('"PUBLIC_URL" should be a full URL');
	}

	await validateDatabaseExtensions();
	await validateStorage();

	await registerAuthProviders();

	const extensionManager = getExtensionManager();
	const flowManager = getFlowManager();

	await extensionManager.initialize();
	await flowManager.initialize();

	const app = express();

	app.disable('x-powered-by');
	app.set('trust proxy', env['IP_TRUST_PROXY']);
	app.set('query parser', (str: string) => qs.parse(str, { depth: 10 }));


	if (env['PRESSURE_LIMITER_ENABLED']) {
		const sampleInterval = Number(env['PRESSURE_LIMITER_SAMPLE_INTERVAL']);

		if (Number.isNaN(sampleInterval) === true || Number.isFinite(sampleInterval) === false) {
			throw new Error(`Invalid value for PRESSURE_LIMITER_SAMPLE_INTERVAL environment variable`);
		}

		app.use(
			handlePressure({
				sampleInterval,
				maxEventLoopUtilization: env['PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION'] as number,
				maxEventLoopDelay: env['PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY'] as number,
				maxMemoryRss: env['PRESSURE_LIMITER_MAX_MEMORY_RSS'] as number,
				maxMemoryHeapUsed: env['PRESSURE_LIMITER_MAX_MEMORY_HEAP_USED'] as number,
				error: new ServiceUnavailableError({ service: 'api', reason: 'Under pressure' }),
				retryAfter: env['PRESSURE_LIMITER_RETRY_AFTER'] as string,
			}),
		);
	}

	app.use(
		helmet.contentSecurityPolicy(
			merge(
				{
					useDefaults: true,
					directives: {
						// Unsafe-eval is required for app extensions
						scriptSrc: ["'self'", "'unsafe-eval'"],

						// Even though this is recommended to have enabled, it breaks most local
						// installations. Making this opt-in rather than opt-out is a little more
						// friendly. Ref #10806
						upgradeInsecureRequests: null,

						// These are required for MapLibre
						workerSrc: ["'self'", 'blob:'],
						childSrc: ["'self'", 'blob:'],
						imgSrc: [
							"'self'",
							'data:',
							'blob:',
							'https://raw.githubusercontent.com',
							'https://avatars.githubusercontent.com',
						],
						mediaSrc: ["'self'"],
						connectSrc: ["'self'", 'https://*'],
					},
				},
				getConfigFromEnv('CONTENT_SECURITY_POLICY_'),
			),
		),
	);

	if (env['HSTS_ENABLED']) {
		app.use(helmet.hsts(getConfigFromEnv('HSTS_', ['HSTS_ENABLED'])));
	}

	await emitter.emitInit('app.before', { app });

	await emitter.emitInit('middlewares.before', { app });

	app.use(createExpressLogger());

	app.use((_req, res, next) => {
		res.setHeader('X-Powered-By', 'Directus');
		next();
	});

	if (env['CORS_ENABLED'] === true) {
		app.use(cors);
	}

	app.use((req, res, next) => {
		(
			express.json({
				limit: env['MAX_PAYLOAD_SIZE'] as string,
			}) as RequestHandler
		)(req, res, (err: any) => {
			if (err) {
				return next(new InvalidPayloadError({ reason: err.message }));
			}

			return next();
		});
	});

	app.use(cookieParser());

	app.use(extractToken);

	app.get('/', (_req, res, next) => {
		if (env['ROOT_REDIRECT']) {
			res.redirect(env['ROOT_REDIRECT'] as string);
		} else {
			next();
		}
	});

	app.get(`/${basePath}`, (_req, res, next) => {
		if (env['ROOT_REDIRECT']) {
			res.redirect(env['ROOT_REDIRECT'] as string);
		} else {
			next();
		}
	});

	app.get('/robots.txt', (_, res) => {
		res.set('Content-Type', 'text/plain');
		res.status(200);
		res.send(env['ROBOTS_TXT']);
	});

	if (env['SERVE_APP']) {
		const adminPath = require.resolve('@directus/app');
		const adminUrl = new Url(env['PUBLIC_URL'] as string).addPath(`${basePath}/admin`);

		const embeds = extensionManager.getEmbeds();

		// Set the App's base path according to the APIs public URL
		const html = await readFile(adminPath, 'utf8');

		const htmlWithVars = html
			.replace(/<base \/>/, `<base href="${adminUrl.toString({ rootRelative: true })}/" />`)
			.replace('<!-- directus-embed-head -->', embeds.head)
			.replace('<!-- directus-embed-body -->', embeds.body);

		const sendHtml = (_req: Request, res: Response) => {
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('Vary', 'Origin, Cache-Control');
			res.send(htmlWithVars);
		};

		const setStaticHeaders = (res: ServerResponse) => {
			res.setHeader('Cache-Control', 'max-age=31536000, immutable');
			res.setHeader('Vary', 'Origin, Cache-Control');
		};

		app.get(`${basePathUrl}/admin`, sendHtml);
		app.use(`${basePathUrl}/admin`, express.static(path.join(adminPath, '..'), { setHeaders: setStaticHeaders }));
		app.use(`${basePathUrl}/admin/*`, sendHtml);
	}

	// use the rate limiter - all routes for now
	if (env['RATE_LIMITER_GLOBAL_ENABLED'] === true) {
		app.use(rateLimiterGlobal);
	}

	if (env['RATE_LIMITER_ENABLED'] === true) {
		app.use(rateLimiter);
	}

	app.get(`${basePathUrl}/server/ping`, (_req, res) => res.send('pong'));

	app.use(authenticate);

	app.use(sanitizeQuery);

	app.use(cache);

	app.use(schema);

	await emitter.emitInit('middlewares.after', { app });

	await emitter.emitInit('routes.before', { app });

	app.use(`${basePathUrl}/auth`, authRouter);

	app.use(`${basePathUrl}/graphql`, graphqlRouter);

	app.use(`${basePathUrl}/activity`, activityRouter);
	app.use(`${basePathUrl}/access`, accessRouter);
	app.use(`${basePathUrl}/assets`, assetsRouter);
	app.use(`${basePathUrl}/collections`, collectionsRouter);
	app.use(`${basePathUrl}/dashboards`, dashboardsRouter);
	app.use(`${basePathUrl}/extensions`, extensionsRouter);
	app.use(`${basePathUrl}/fields`, fieldsRouter);

	if (env['TUS_ENABLED'] === true) {
		app.use(`${basePathUrl}/files/tus`, tusRouter);
	}

	app.use(`${basePathUrl}/files`, filesRouter);
	app.use(`${basePathUrl}/flows`, flowsRouter);
	app.use(`${basePathUrl}/folders`, foldersRouter);
	app.use(`${basePathUrl}/items`, itemsRouter);
	app.use(`${basePathUrl}/notifications`, notificationsRouter);
	app.use(`${basePathUrl}/operations`, operationsRouter);
	app.use(`${basePathUrl}/panels`, panelsRouter);
	app.use(`${basePathUrl}/permissions`, permissionsRouter);
	app.use(`${basePathUrl}/policies`, policiesRouter);
	app.use(`${basePathUrl}/presets`, presetsRouter);
	app.use(`${basePathUrl}/translations`, translationsRouter);
	app.use(`${basePathUrl}/relations`, relationsRouter);
	app.use(`${basePathUrl}/revisions`, revisionsRouter);
	app.use(`${basePathUrl}/roles`, rolesRouter);
	app.use(`${basePathUrl}/schema`, schemaRouter);
	app.use(`${basePathUrl}/server`, serverRouter);
	app.use(`${basePathUrl}/settings`, settingsRouter);
	app.use(`${basePathUrl}/shares`, sharesRouter);
	app.use(`${basePathUrl}/users`, usersRouter);
	app.use(`${basePathUrl}/utils`, utilsRouter);
	app.use(`${basePathUrl}/versions`, versionsRouter);
	app.use(`${basePathUrl}/webhooks`, webhooksRouter);

	// Register custom endpoints
	await emitter.emitInit('routes.custom.before', { app });
	app.use(extensionManager.getEndpointRouter());
	await emitter.emitInit('routes.custom.after', { app });

	app.use(notFoundHandler);
	app.use(errorHandler);

	await emitter.emitInit('routes.after', { app });

	initTelemetry();
	scheduleTusCleanup();

	await emitter.emitInit('app.after', { app });

	return app;
}
