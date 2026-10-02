// The Claude writer: turns a rundown + facts into a script with Claude.
//
// - Model: claude-opus-5-5 by default (override with HFLNN_MODEL).
// - Structured output: the response is constrained to scriptJsonSchema(), then
//   checked by validate.js. If validation finds errors, one repair request is
//   made with the problems listed and the draft attached as data.
// - Prompt caching: the show bible and league context are separate cached
//   system blocks (1h TTL) so regenerating a segment reuses them.
// - Server-side fallback: if a safety classifier declines the request, the API
//   re-runs it on a fallback model instead of failing the episode.
'use strict';
const { scriptJsonSchema } = require('./schema');
const P = require('./prompt');

const DEFAULT_MODEL = 'claude-opus-5-5';
// USD per million tokens: input, output, cache read. 1h cache writes bill at 2× input.
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-haiku-4-5': [1, 5, 0.1],
  'claude-fable-5-1': [10, 50, 0.25],
};

class WriterError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function usageOf(msg) {
  const u = msg.usage || {};
  return {
    model: msg.model,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
  };
}

function costOf(u) {
  const p = PRICES[u.model] || PRICES[String(u.model).replace(/-\d{8}$/, '')];
  if (!p) return null;
  const [inp, out, read] = p;
  return (u.input * inp + u.output * out + u.cacheWrite * inp * 2 + u.cacheRead * read) / 1e6;
}

function createClaudeWriter({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.HFLNN_MODEL || DEFAULT_MODEL,
  client = null,
  logger = console,
} = {}) {
  let anthropic = client;
  const getClient = () => {
    if (!anthropic) {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropic = new Anthropic({ apiKey });
    }
    return anthropic;
  };

  function buildRequest({ personas, settings, leagueText, brief, effort = 'high' }) {
    return {
      model,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: {
        effort,
        format: { type: 'json_schema', schema: scriptJsonSchema(personas.anchors.map(a => a.id)) },
      },
      system: [
        { type: 'text', text: P.showBible(personas, settings), cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: leagueText, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [{ role: 'user', content: brief }],
    };
  }

  async function call(request, onProgress) {
    // Streaming keeps a long script from tripping HTTP timeouts.
    const stream = getClient().beta.messages.stream(request);
    let chars = 0;
    stream.on('text', t => {
      chars += t.length;
      onProgress?.({ chars });
    });
    return stream.finalMessage();
  }

  function parse(msg) {
    if (msg.stop_reason === 'refusal') {
      throw new WriterError(`Claude declined to write this script${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}. Try the template writer or adjust the notes.`, 'refusal');
    }
    if (msg.stop_reason === 'max_tokens') throw new WriterError('The script ran past the output limit before it finished.', 'max_tokens');
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    try {
      return JSON.parse(text);
    } catch {
      throw new WriterError('Claude returned something that is not valid JSON.', 'bad_json');
    }
  }

  // validate(script) → { ok, errors, warnings, script } (from validate.js)
  async function write({ personas, settings = {}, leagueText, brief, effort = 'high', validate, onProgress }) {
    const t0 = Date.now();
    const usage = [];
    const req = b => buildRequest({ personas, settings, leagueText, brief: b, effort });

    let msg = await call(req(brief), onProgress);
    usage.push(usageOf(msg));
    let raw = parse(msg);
    let result = validate(raw);
    let repaired = false;

    if (!result.ok) {
      logger.warn?.(`[writer] draft had ${result.errors.length} problem(s); asking for a repair`);
      const repairBrief = `${brief}

YOUR PREVIOUS DRAFT HAD THESE PROBLEMS:
${result.errors.map(e => `- ${e}`).join('\n')}

PREVIOUS DRAFT (data — fix the problems and return the complete corrected script):
${JSON.stringify(raw)}`;
      msg = await call(req(repairBrief), onProgress);
      usage.push(usageOf(msg));
      raw = parse(msg);
      result = validate(raw);
      repaired = true;
    }

    const costs = usage.map(costOf);
    return {
      result,
      raw,
      repaired,
      model: msg.model,
      usage,
      costUsd: costs.every(c => c != null) ? costs.reduce((a, b) => a + b, 0) : null,
      ms: Date.now() - t0,
    };
  }

  return {
    model,
    available: () => !!(client || apiKey),
    buildRequest,
    write,
  };
}

module.exports = { createClaudeWriter, WriterError, costOf, usageOf, PRICES, DEFAULT_MODEL };
