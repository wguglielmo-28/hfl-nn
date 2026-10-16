// The OpenAI writer: the same job as claude.js, done by a GPT model through
// the OpenAI Responses API. Same show bible, league context, brief, script
// schema and validator, so everything downstream (voice booth, player, show
// memory) can't tell which writer drafted a script.
//
// - Model: GPT-6.1 Sol by default (Settings → OpenAI model, or
//   HFLNN_OPENAI_MODEL for the starting value).
// - Effort: `reasoning.effort`, set per model and episode kind (MODELS below).
// - Structured output: `text.format` json_schema with `strict: true`. The
//   script schema already meets strict mode's rules (every property required,
//   no additional properties). One repair request on validation errors, as in
//   claude.js.
// - Prompt caching is automatic on OpenAI for a repeated prefix, so the show
//   bible and league context go first in `instructions` and the brief last.
// - Refusals come back as a `refusal` content item; there's no rescue model,
//   so a decline falls back to the template writer.
// - Transport: node:https, streamed. fetch() would cut the stream after five
//   minutes without a byte (undici's bodyTimeout), and a long show can think
//   that long before it writes.
'use strict';
const https = require('node:https');
const { scriptJsonSchema } = require('./schema');
const P = require('./prompt');
const { WriterError } = require('./claude');

const API_URL = 'https://api.openai.com/v1/responses';
const TIMEOUT_MS = 15 * 60 * 1000;

const MODELS = {
  'gpt-6.1-sol': { label: 'GPT-6.1 Sol (same price as Sonnet 5.5)', effort: { show: 'medium', bulletin: 'low' } },
  'gpt-6-astra': { label: 'GPT-6 Astra (flagship, 5× Sol\'s price)', effort: { show: 'high', bulletin: 'medium' } },
  'gpt-6-luna': { label: 'GPT-6 Luna (cheapest)', effort: { show: 'medium', bulletin: 'low' } },
};
const DEFAULT_MODEL = 'gpt-6.1-sol';
const effortFor = (model, kind = 'show') => (MODELS[model]?.effort || MODELS[DEFAULT_MODEL].effort)[kind === 'bulletin' ? 'bulletin' : 'show'];
// USD per million tokens: input, cached input, output (OpenAI's Standard tier, October 2026).
const PRICES = {
  'gpt-6-astra': [10, 1, 50],
  'gpt-6.1-sol': [2, 0.1, 10],
  'gpt-6-sol': [2, 0.2, 10],
  'gpt-6-luna': [0.1, 0.01, 0.5],
  'gpt-5.6-sol': [4, 0.4, 20],
  'gpt-5.6-terra': [2, 0.2, 12],
  'gpt-5.6-luna': [0.2, 0.02, 1.2],
  'gpt-5.5': [5, 0.5, 30],
};

const baseModel = m => String(m || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');

// Same record shape as claude.js, so the control room adds them up the same
// way. OpenAI counts cached tokens inside input_tokens; `input` here is the
// uncached part. Reasoning tokens are billed as output and already in it.
function usageOf(res) {
  const u = res.usage || {};
  const cached = u.input_tokens_details?.cached_tokens || 0;
  return {
    model: baseModel(res.model),
    input: Math.max(0, (u.input_tokens || 0) - cached),
    output: u.output_tokens || 0,
    cacheWrite: 0,
    cacheRead: cached,
  };
}

function costOf(u) {
  const p = PRICES[baseModel(u.model)];
  if (!p) return null;
  const [inp, read, out] = p;
  return (u.input * inp + u.cacheRead * read + u.output * out) / 1e6;
}

// POSTs `body` and yields the response's server-sent events as parsed JSON.
function httpsTransport({ url, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, res => {
      res.setEncoding('utf8');
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let text = '';
        res.on('data', c => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
        return;
      }
      resolve({ status: res.statusCode, events: sseEvents(res) });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('OpenAI took longer than 15 minutes')));
    req.on('error', reject);
    req.end(body);
  });
}

async function* sseEvents(chunks) {
  let buf = '';
  for await (const chunk of chunks) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* a keep-alive or partial line */ }
    }
  }
}

function apiError(status, text) {
  let msg = '';
  try { msg = JSON.parse(text)?.error?.message || ''; } catch { /* not JSON */ }
  const hint = status === 401 ? ' Check OPENAI_API_KEY.' : status === 429 ? ' Rate limit or no API credit left on the OpenAI account.' : '';
  return new WriterError(`OpenAI returned HTTP ${status}${msg ? `: ${msg.slice(0, 300)}` : ''}.${hint}`, `http_${status}`);
}

function createOpenAIWriter({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.HFLNN_OPENAI_MODEL || DEFAULT_MODEL,
  transport = httpsTransport,
  logger = console,
} = {}) {
  function buildRequest({ personas, settings, leagueText, brief, model: m = model, effort = effortFor(m) }) {
    return {
      model: m,
      stream: true,
      store: false,
      max_output_tokens: 64000,   // reasoning tokens count against this too
      reasoning: { effort },
      prompt_cache_key: 'hfl-nn-writer',
      instructions: `${P.showBible(personas, settings)}\n\n${leagueText}`,
      input: [{ role: 'user', content: brief }],
      text: {
        format: { type: 'json_schema', name: 'hfl_nn_script', strict: true, schema: scriptJsonSchema(personas.anchors.map(a => a.id)) },
      },
    };
  }

  // Streams one request to its final response object.
  async function call(request, onProgress) {
    const res = await transport({
      url: API_URL,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(request),
    });
    if (!res.events) throw apiError(res.status, res.text);
    let chars = 0;
    for await (const ev of res.events) {
      if (ev.type === 'response.output_text.delta' || ev.type === 'response.refusal.delta') {
        chars += (ev.delta || '').length;
        onProgress?.({ chars });
      } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') {
        return ev.response;
      } else if (ev.type === 'error') {
        throw new WriterError(`OpenAI stream error: ${ev.message || ev.error?.message || 'unknown'}`, 'stream_error');
      }
    }
    throw new WriterError('The OpenAI stream ended before the script finished.', 'stream_ended');
  }

  function parse(res) {
    if (res.status === 'failed') throw new WriterError(`OpenAI failed to write the script: ${res.error?.message || 'no reason given'}`, 'failed');
    if (res.status === 'incomplete') {
      const why = res.incomplete_details?.reason;
      throw new WriterError(why === 'max_output_tokens' ? 'The script ran past the output limit before it finished.' : `OpenAI stopped early${why ? ` (${why})` : ''}.`, why || 'incomplete');
    }
    const content = (res.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []);
    const refusal = content.find(c => c.type === 'refusal');
    if (refusal) throw new WriterError(`OpenAI declined to write this script${refusal.refusal ? ` ("${String(refusal.refusal).slice(0, 160)}")` : ''}. Try the template writer or adjust the notes.`, 'refusal');
    const text = content.filter(c => c.type === 'output_text').map(c => c.text).join('');
    try {
      return JSON.parse(text);
    } catch {
      throw new WriterError('OpenAI returned something that is not valid JSON.', 'bad_json');
    }
  }

  // Same contract as the Claude writer's write().
  async function write({ personas, settings = {}, leagueText, brief, model: m = model, kind = 'show', effort, validate, onProgress }) {
    const t0 = Date.now();
    const usage = [];
    const draft = async b => {
      const res = await call(buildRequest({ personas, settings, leagueText, brief: b, model: m, effort: effort ?? effortFor(m, kind) }), onProgress);
      usage.push(usageOf(res));
      return res;
    };

    let res = await draft(brief);
    let raw = parse(res);
    let result = validate(raw);
    let repaired = false;

    if (!result.ok) {
      logger.warn?.(`[writer] draft had ${result.errors.length} problem(s); asking for a repair`);
      const repairBrief = `${brief}

YOUR PREVIOUS DRAFT HAD THESE PROBLEMS:
${result.errors.map(e => `- ${e}`).join('\n')}

PREVIOUS DRAFT (data — fix the problems and return the complete corrected script):
${JSON.stringify(raw)}`;
      res = await draft(repairBrief);
      raw = parse(res);
      result = validate(raw);
      repaired = true;
    }

    const costs = usage.map(costOf);
    return {
      result,
      raw,
      repaired,
      model: baseModel(res.model) || m,
      usage,
      costUsd: costs.every(c => c != null) ? costs.reduce((a, b) => a + b, 0) : null,
      ms: Date.now() - t0,
    };
  }

  return {
    model,
    available: () => !!apiKey,
    buildRequest,
    write,
  };
}

module.exports = { createOpenAIWriter, costOf, usageOf, effortFor, sseEvents, PRICES, MODELS, DEFAULT_MODEL };
