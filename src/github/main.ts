import { readFileSync } from 'node:fs';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, splitList } from '../core/glob.js';
import { DEFAULT_MAP_OPTIONS } from '../core/map.js';
import { addSummary, getBool, getInput, getNumber, log, setFailed, setOutput, setSecret } from './actions.js';
import { GitHubApi } from './api.js';
import { run, type Config } from './run.js';

function readConfig(): Config {
  const lang = getInput('lang', 'en').toLowerCase().startsWith('it') ? 'it' : 'en';
  const secret = getInput('secret', '');
  if (secret) setSecret(secret);
  const timeout = getNumber('timeout-seconds', 0);
  const mode = getInput('mode', 'auto').toLowerCase();
  return {
    testCommand: getInput('test-command', 'npm test'),
    lang,
    secret: secret || undefined,
    maxMutants: Math.max(2, Math.min(20, getNumber('max-mutants', 8))),
    optionsCount: Math.max(2, Math.min(4, getNumber('options', 3))),
    timeoutMs: timeout > 0 ? timeout * 1000 : undefined,
    aiOnly: getBool('ai-only', true),
    aiMarkers: splitList(getInput('ai-markers', '')),
    include: splitList(getInput('include', '')).length ? splitList(getInput('include', '')) : DEFAULT_INCLUDE,
    exclude: [...DEFAULT_EXCLUDE, ...splitList(getInput('exclude', ''))],
    halfLifeDays: getNumber('half-life-days', DEFAULT_MAP_OPTIONS.halfLifeDays),
    linesPerProof: getNumber('lines-per-proof', DEFAULT_MAP_OPTIONS.linesPerProof),
    minAiLines: getNumber('min-ai-lines', DEFAULT_MAP_OPTIONS.minAiLines),
    darkThreshold: getNumber('dark-threshold', DEFAULT_MAP_OPTIONS.darkThreshold),
    dataBranch: getInput('data-branch', 'capito-data'),
    anonymous: getBool('anonymous', false),
    digestFiles: Math.max(1, Math.min(5, getNumber('review-files', 2))),
    treatAllAsAi: getBool('treat-all-as-ai', false),
    alertOnIssues: getBool('alert-on-issues', true),
    includeDrafts: getBool('include-drafts', false),
    mode: mode === 'digest' || mode === 'review' ? 'digest' : mode === 'map' ? 'map' : 'auto',
  };
}

async function main(): Promise<void> {
  const token = getInput('github-token', process.env.GITHUB_TOKEN ?? '');
  if (!token) throw new Error('Missing github-token');
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {};
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const config = readConfig();
  log.info(`Capito: event=${eventName} action=${event.action ?? '-'} repo=${repo} lang=${config.lang}`);
  const outcome = await run({
    eventName,
    event,
    repo,
    cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
    sha: process.env.GITHUB_SHA,
    api: new GitHubApi(token, repo),
    config,
    log: { info: log.info, warning: log.warning },
    summary: addSummary,
    output: setOutput,
  });
  setOutput('outcome', outcome.action);
  log.info(`Capito: ${outcome.action}${outcome.reason ? ` (${outcome.reason})` : ''}`);
}

main().catch((e) => setFailed(e instanceof Error ? (e.stack ?? e.message) : String(e)));
