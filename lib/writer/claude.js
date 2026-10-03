// The Claude writer: turns a rundown + facts into a script with Claude.
//
// - Model: Claude Sonnet 5.5 by default, Opus 5.5 on request (Settings →
//   Claude model, or HFLNN_MODEL for the starting value).
// - Effort: set per model and episode kind (MODELS below). Sonnet 5.5's
//   levels are recalibrated, and Anthropic's suggested starting point for
//   content writing is low; a full show is long and fact-checked, so it runs a
//   step above that.
// - Structured output: the response is constrained to scriptJsonSchema(), then
//   checked by validate.js. If validation finds errors, one repair request is
//   made with the problems listed and the draft attached as data.
// - Prompt caching: the show bible and league context are separate cached
//   system blocks (1h TTL) so regenerating a segment reuses them.
// - Refusals: server-side fallback (`fallbacks: "default"`) re-runs some
//   declines on another model. Sonnet 5.5 can also decline in categories that
//   fallback doesn't retry, so a decline there gets one retry on Opus 5.5
//   before the episode falls back to the template writer.
'use strict';
const { scriptJsonSchema } = require('./schema');
const P = require('./prompt');

// The models the control room offers, with the effort each runs at for a full
// show and for a short bulletin.
const MODELS = {
  'claude-sonnet-5-5': { label: 'Sonnet 5.5 (half price)', effort: { show: 'medium', bulletin: 'low' } },
  'claude-opus-5-5': { label: 'Opus 5.5 (best writing)', effort: { show: 'high', bulletin: 'medium' } },
};
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const RESCUE_MODEL = 'claude-opus-5-5';
const effortFor = (model, kind = 'show') => (MODELS[model]?.effort || MODELS[RESCUE_MODEL].effort)[kind === 'bulletin' ? 'bulletin' : 'show'];
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

  function buildRequest({ personas, settings, leagueText, brief, model: m = model, effort = effortFor(m) }) {
    return {
      model: m,
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
  // kind: 'show' or 'bulletin' picks the effort; `effort` overrides it.
  async function write({ personas, settings = {}, leagueText, brief, model: m = model, kind = 'show', effort, validate, onProgress }) {
    const t0 = Date.now();
    const usage = [];
    let active = m;

    // One request; a decline on a cheaper model gets one more try on Opus.
    async function draft(b) {
      let msg = await call(buildRequest({ personas, settings, leagueText, brief: b, model: active, effort: effort ?? effortFor(active, kind) }), onProgress);
      usage.push(usageOf(msg));
      if (msg.stop_reason === 'refusal' && active !== RESCUE_MODEL) {
        logger.warn?.(`[writer] ${active} declined (${msg.stop_details?.category || 'no category'}); retrying on ${RESCUE_MODEL}`);
        active = RESCUE_MODEL;
        msg = await call(buildRequest({ personas, settings, leagueText, brief: b, model: active, effort: effortFor(active, kind) }), onProgress);
        usage.push(usageOf(msg));
      }
      return msg;
    }

    let msg = await draft(brief);
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
      msg = await draft(repairBrief);
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

module.exports = { createClaudeWriter, WriterError, costOf, usageOf, effortFor, PRICES, MODELS, DEFAULT_MODEL, RESCUE_MODEL };
