import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * The few bits of the GitHub Actions toolkit Capito needs,
 * reimplemented so the action has zero runtime dependencies.
 */

export function getInput(name: string, fallback = ''): string {
  const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

export function getBool(name: string, fallback: boolean): boolean {
  const v = getInput(name, '').toLowerCase();
  if (v === '') return fallback;
  return ['true', 'yes', '1', 'on', 'si', 'sì'].includes(v);
}

export function getNumber(name: string, fallback: number): number {
  const v = Number(getInput(name, ''));
  return Number.isFinite(v) && getInput(name, '') !== '' ? v : fallback;
}

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export const log = {
  info: (msg: string) => process.stdout.write(msg + '\n'),
  warning: (msg: string) => process.stdout.write(`::warning::${escapeData(msg)}\n`),
  error: (msg: string) => process.stdout.write(`::error::${escapeData(msg)}\n`),
  group: (name: string) => process.stdout.write(`::group::${name}\n`),
  endGroup: () => process.stdout.write('::endgroup::\n'),
};

export function setSecret(value: string): void {
  if (value) process.stdout.write(`::add-mask::${escapeData(value)}\n`);
}

export function setOutput(name: string, value: string | number): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `capito_${randomBytes(8).toString('hex')}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function addSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    log.info(markdown);
    return;
  }
  appendFileSync(file, markdown + '\n\n');
}

export function setFailed(msg: string): void {
  log.error(msg);
  process.exitCode = 1;
}
