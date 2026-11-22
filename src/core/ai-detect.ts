/**
 * Recognise commits written (fully or partly) by AI coding agents.
 *
 * Agents usually leave a fingerprint: a `Co-Authored-By:` trailer, a
 * "Generated with ..." footer, or a bot author account. The list is
 * deliberately broad; users can add their own patterns with `ai-markers`.
 */

const AGENTS =
  'claude|anthropic|copilot|codex|openai|chatgpt|gpt-engineer|cursor|devin|gemini|jules|aider|windsurf|codeium|cline|roo|amp|sourcegraph|lovable|bolt|replit|v0|tabnine|amazon q|kiro|qodo|sweep|factory|droid|opencode|goose|junie|augment';

export const DEFAULT_AI_MESSAGE_PATTERNS: RegExp[] = [
  new RegExp(`^co-authored-by:.*\\b(${AGENTS})\\b`, 'im'),
  /generated (with|by) \[?(claude|copilot|codex|cursor|gemini|aider|devin|lovable|bolt|replit|v0)/i,
  /🤖 generated with/i,
  /^(assisted|generated)-by:\s*\S+/im,
  /^ai-(assisted|generated):\s*(yes|true)/im,
];

/** Narrower list for author names, to avoid matching humans called e.g. "Amp" or "Bolt". */
const AUTHOR_AGENTS = 'claude|copilot|codex|chatgpt|cursor|devin|jules|aider|lovable|gpt-engineer|openhands|sweep|codegen|v0';

export const DEFAULT_AI_AUTHOR_PATTERNS: RegExp[] = [
  new RegExp(`^(${AUTHOR_AGENTS})([-_ ](agent|bot|ai|app|code|dev))?(\\[bot\\])?$`, 'i'),
  /^copilot-swe-agent(\[bot\])?$/i,
  /^devin-ai-integration(\[bot\])?$/i,
  /^google-labs-jules(\[bot\])?$/i,
  /^(gpt-engineer-app|lovable-dev)(\[bot\])?$/i,
  /^replit[- ]agent$/i,
];

export interface CommitInfo {
  sha: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
  authorLogin?: string;
  committerName?: string;
}

export interface AiDetector {
  isAiCommit(c: CommitInfo): string | null;
}

/** Returns a short human-readable reason when the commit looks AI-written, otherwise null. */
export function makeAiDetector(extraPatterns: string[] = []): AiDetector {
  const extra = extraPatterns
    .map((p) => {
      try {
        return new RegExp(p, 'im');
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
  return {
    isAiCommit(c) {
      for (const re of [...DEFAULT_AI_MESSAGE_PATTERNS, ...extra]) {
        const m = re.exec(c.message);
        if (m) return m[0].trim().slice(0, 80);
      }
      for (const who of [c.authorLogin, c.authorName, c.committerName]) {
        if (!who) continue;
        for (const re of DEFAULT_AI_AUTHOR_PATTERNS) if (re.test(who.trim())) return `author: ${who.trim()}`;
      }
      return null;
    },
  };
}
