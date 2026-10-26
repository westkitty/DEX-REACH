import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { renderMarkdown } from './markdown-render.js';
import { pdf2md } from './lib/pdf2md.js';
import { CONFIG_FILE } from '../../config.js';
const isUrl = (source) => source.startsWith('http://') || source.startsWith('https://');
// Cached Chrome path to avoid repeated lookups
let cachedChromePath = null; // null = not checked yet
let chromeCheckPromise = null;
/**
 * Get Desktop Commander's private Puppeteer cache directory.
 */
function getPuppeteerCacheDir() {
    return join(dirname(CONFIG_FILE), 'puppeteer-cache');
}
/**
 * Get the cache path where Puppeteer stores Chrome for Testing builds.
 */
function getPuppeteerChromeDir(cacheDir = getPuppeteerCacheDir()) {
    return join(cacheDir, 'chrome');
}
/**
 * Find the platform-specific executable within a cached Chrome build directory.
 */
function getChromeExecutablePath(chromeDir, version) {
    const chromePath = process.platform === 'win32'
        ? join(chromeDir, version, 'chrome-win64', 'chrome.exe')
        : process.platform === 'darwin'
            ? join(chromeDir, version, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
            : join(chromeDir, version, 'chrome-linux64', 'chrome');
    if (existsSync(chromePath)) {
        return chromePath;
    }
    // Also check for arm64 mac
    if (process.platform === 'darwin') {
        const armPath = join(chromeDir, version, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(armPath)) {
            return armPath;
        }
    }
    return undefined;
}
/**
 * Resolve the cached Chrome build directory that owns an executable path.
 */
function getCachedChromeBuildDir(chromeDir, executablePath) {
    const relativePath = relative(chromeDir, executablePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        return undefined;
    }
    const [buildDir] = relativePath.split(sep);
    return buildDir ? join(chromeDir, buildDir) : undefined;
}
/**
 * Find Chrome in puppeteer's cache directory
 * Returns the executable path if found, undefined otherwise
 */
export function findPuppeteerChrome(cacheDir = getPuppeteerCacheDir()) {
    const chromeDir = getPuppeteerChromeDir(cacheDir);
    if (!existsSync(chromeDir)) {
        return undefined;
    }
    try {
        // Look for chrome directories (e.g., win64-143.0.7499.169)
        const versions = readdirSync(chromeDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions) {
            const executablePath = getChromeExecutablePath(chromeDir, version);
            if (executablePath) {
                return { executablePath };
            }
        }
    }
    catch {
        // Ignore errors reading cache directory
    }
    return undefined;
}
/**
 * Find system-installed Chrome/Chromium browser
 * Returns the executable path if found, undefined otherwise
 */
function findSystemChrome() {
    const paths = process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            'C:\\Program Files\\Chromium\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
        ]
        : process.platform === 'darwin'
            ? [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
                '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
                '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
            ]
            : [
                // Linux paths
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
                '/snap/bin/chromium',
            ];
    return paths.find(p => existsSync(p));
}
/**
 * Find already installed Chrome for PDF generation
 * Priority: 1. Existing private cache, 2. System Chrome; no downloads
 * Results are cached to avoid repeated lookups
 */
async function getChromePath() {
    // Return cached result if available
    if (cachedChromePath !== null) {
        return cachedChromePath;
    }
    // If a check is already in progress, wait for it
    if (chromeCheckPromise) {
        return chromeCheckPromise;
    }
    // Start the check
    chromeCheckPromise = (async () => {
        // 1. Check puppeteer cache first (exact compatible version)
        const cachedChrome = findPuppeteerChrome();
        if (cachedChrome) {
            cachedChromePath = cachedChrome.executablePath;
            return cachedChrome.executablePath;
        }
        // 2. Check system Chrome
        const systemChrome = findSystemChrome();
        if (systemChrome) {
            cachedChromePath = systemChrome;
            return systemChrome;
        }
        throw new Error('DEX PDF generation requires an already installed Chrome or Chromium; automatic installation is disabled');
    })();
    const result = await chromeCheckPromise;
    chromeCheckPromise = null;
    return result;
}
/**
 * Preemptively ensure Chrome is available for PDF generation.
 * Call this at server startup to trigger download in background if needed.
 * Returns immediately, download happens in background.
 */
export function ensureChromeAvailable() {
    // Don't await - let it run in background
    getChromePath().catch((error) => {
        console.error('Background Chrome check failed:', error);
    });
}
async function loadPdfToBuffer(source) {
    if (source instanceof Uint8Array || source instanceof ArrayBuffer) return source;
    if (isUrl(source)) {
        const response = await fetch(source);
        return await response.arrayBuffer();
    }
    else {
        return await fs.readFile(source);
    }
}
/**
 * Convert PDF to Markdown using @opendocsg/pdf2md
 */
export async function parsePdfToMarkdown(source, pageNumbers = []) {
    try {
        const data = await loadPdfToBuffer(source);
        // @ts-ignore: Type definition mismatch for ESM usage
        return await pdf2md(new Uint8Array(data), pageNumbers);
    }
    catch (error) {
        console.error("Error converting PDF to Markdown (v3):", error);
        throw error;
    }
}
export async function parseMarkdownToPdf(markdown, options = {}) {
    return renderMarkdown(markdown, options, await getChromePath());
}
