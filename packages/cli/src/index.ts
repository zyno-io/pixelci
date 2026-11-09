import { existsSync } from 'fs';

import { getApi } from './api.js';
import { reportGitHubResult } from './ci-github.js';
import { getJobInfo } from './ci.js';
import { AppError, handleError } from './error.js';
import { getImages, getScreenName } from './glob.js';

process.on('unhandledRejection', handleError);
process.on('uncaughtException', handleError);

const sourcePath = process.argv[2] ?? process.env.PIXELCI_IMAGES_PATH;
if (!sourcePath) throw new AppError('No source path provided. Use PIXELCI_IMAGES_PATH environment variable or pass as argument');
if (!existsSync(sourcePath)) throw new AppError(`Source path "${sourcePath}" does not exist`);

const imageFiles = await getImages(sourcePath);
if (!imageFiles.length) throw new AppError(`No PNG files found in "${sourcePath}"`);

const jobInfo = await getJobInfo();
if (!jobInfo) throw new AppError('No job information found in CI');

const api = getApi(jobInfo);

console.log('\nCreating build...');
const { buildId, status } = await api.createBuild();

let buildStatus = status;

if (buildStatus === 'draft') {
    console.log(`Build ${buildId} created.`);

    for (const imageFile of imageFiles) {
        const screenName = getScreenName(sourcePath, imageFile);
        console.log(`\nUploading screen "${screenName}"...`);
        await api.uploadScreen(buildId, imageFile, screenName);
        console.log(`Screen "${screenName}" uploaded.`);
    }

    console.log(`\nFinalizing build...`);
    await api.processBuild(buildId);
    buildStatus = 'processing';
} else {
    console.log(`Build already exists.`);
}

const timeoutMins = 5;
const timeoutMs = timeoutMins * 60 * 1000;
const expMs = Date.now() + timeoutMs;
while (buildStatus === 'processing' && Date.now() < expMs) {
    console.log('\nChecking build status...');
    buildStatus = await api.getBuildStatus(buildId);

    if (buildStatus === 'processing') {
        console.log('Build is still processing.');
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

if (buildStatus === 'processing') {
    throw new AppError(`Build ${buildId} is still processing after ${timeoutMins} minutes. Timing out.`);
}

console.log(`\nBuild status: ${buildStatus}`);
const buildUrl = api.getBuildUserUrl(buildId);
console.log(`\nSee details at:\n${buildUrl}`);
reportGitHubResult(buildStatus, buildUrl);

if (buildStatus === 'failed') {
    throw new AppError(`Build ${buildId} failed during processing.`);
}

if (buildStatus === 'changes rejected') {
    console.error(`Build ${buildId} was rejected during review.`);
    process.exit(1);
}

if (buildStatus === 'needs review') {
    process.exit(1);
}

process.exit(0);
