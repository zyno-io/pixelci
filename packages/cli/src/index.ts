import { existsSync } from 'fs';

import { getApi } from './api.js';
import { reportGitHubResult } from './ci-github.js';
import { getJobInfo } from './ci.js';
import { AppError, handleError } from './error.js';
import { getImages, getScreenName } from './glob.js';
import { assertUniqueNames, buildManifest } from './manifest.js';
import { parseShard, parseTimeoutMs, shardWarning } from './options.js';
import { outcomeFor } from './status.js';

process.on('unhandledRejection', handleError);
process.on('uncaughtException', handleError);

const POLL_INTERVAL_MS = 5000;

const sourcePath = process.argv[2] ?? process.env.PIXELCI_IMAGES_PATH;
if (!sourcePath) throw new AppError('No source path provided. Use PIXELCI_IMAGES_PATH environment variable or pass as argument');
if (!existsSync(sourcePath)) throw new AppError(`Source path "${sourcePath}" does not exist`);

const timeoutMs = parseTimeoutMs();
const parsedShard = parseShard();
// 1/1 is just an unsharded build
const shard = parsedShard && parsedShard.total > 1 ? parsedShard : undefined;
const warning = shardWarning();
if (warning) console.warn(`Warning: ${warning}`);

const imageFiles = await getImages(sourcePath);
if (!imageFiles.length && !shard) throw new AppError(`No PNG files found in "${sourcePath}"`);

const screens = imageFiles.map(file => ({ file, name: getScreenName(sourcePath, file) }));
assertUniqueNames(screens);
const manifest = buildManifest(screens.map(s => s.name));

const jobInfo = await getJobInfo();
if (!jobInfo) throw new AppError('No job information found in CI');

const api = getApi(jobInfo);

console.log('\nCreating build...');
const { buildId, status, shard: shardEcho } = await api.createBuild({ screens: manifest, shard });

if (shard && (shardEcho?.index !== shard.index || shardEcho?.total !== shard.total)) {
    throw new AppError("PIXELCI_SHARD is set, but this PixelCI server doesn't support sharded builds. Upgrade the server or unset PIXELCI_SHARD.");
}

let buildStatus = status;

if (buildStatus === 'draft') {
    console.log(`Build ${buildId} created.`);

    for (const { file, name } of screens) {
        console.log(`\nUploading screen "${name}"...`);
        await api.uploadScreen(buildId, file, name);
        console.log(`Screen "${name}" uploaded.`);
    }

    console.log(`\nFinalizing build...`);
    await api.processBuild(buildId, manifest);
    buildStatus = 'processing';
} else {
    console.log(`Another job uploaded this commit's screenshots; waiting for its result.`);
}

const expMs = Date.now() + timeoutMs;
while (buildStatus === 'processing' && Date.now() < expMs) {
    console.log('\nChecking build status...');
    buildStatus = await api.getBuildStatus(buildId);

    if (buildStatus === 'processing') {
        console.log('Build is still processing.');
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

if (buildStatus === 'processing') {
    throw new AppError(`Build ${buildId} is still processing after ${Math.round(timeoutMs / 60_000)} minutes. Timing out.`);
}

console.log(`\nBuild status: ${buildStatus}`);
const buildUrl = api.getBuildUserUrl(buildId);
console.log(`\nSee details at:\n${buildUrl}`);
reportGitHubResult(buildStatus, buildUrl);

const outcome = outcomeFor(buildStatus);
(outcome.code === 0 ? console.log : console.error)(`\n${outcome.message}`);
// the only exit path: 0 iff the status is in PASSING
process.exit(outcome.code);
