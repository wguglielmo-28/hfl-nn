// The script contract shared by both writers (Claude and the offline template
// writer), the validator, the voice booth and the player.
//
// The JSON schema below is what Claude's structured output is constrained to.
// It only varies with the anchor lineup, so the request prefix stays cacheable
// from episode to episode. Segment ids and card ids are free strings here and
// are checked against the rundown by validate.js.
//
// Every enum adds to the grammar the API compiles for strict output, and past
// a size limit the request fails with 400 "The compiled grammar is too large".
// So enums stay only on the spoken line (speaker, emotion, gesture, shot),
// where a bad value would break the broadcast. Persona and status fields in
// fanPoll and memoryUpdates are plain strings that name their allowed values;
// validate.js already drops or defaults anything outside them. `lean` drops
// the line enums too, for the writer's one retry after a grammar-size 400.
//
// Trimming enums wasn't enough. The nested memoryUpdates object (six arrays of
// objects) is most of the grammar, so `memoryAsText` turns it into one string
// field holding JSON text, described by its shape. The writer parses it back
// into an object before validation (see claude.js). The script itself stays
// strictly typed.
'use strict';
const { ARC_STATUS, CASE_STATUS, REL_CHANGE, DECIDED_BY } = require('../memory');

const EMOTIONS = ['neutral', 'happy', 'excited', 'angry', 'smug', 'shocked', 'sad', 'laughing', 'suspicious', 'serious'];
const GESTURES = ['none', 'point', 'shrug', 'desk_slam', 'facepalm', 'lean_in', 'thumbs_up', 'arms_crossed'];
const SHOTS = ['auto', 'wide', 'single', 'two_shot', 'graphic', 'full_graphic'];

function fullScriptSchema(personaIds, { lean = false } = {}) {
  const oneOf = (values, description) => ({
    type: 'string',
    description: `${description ? `${description} ` : ''}One of: ${values.map(v => (v === '' ? '""' : v)).join(', ')}.`,
  });
  const pick = (values, description) => (lean ? oneOf(values, description) : { type: 'string', enum: values, ...(description ? { description } : {}) });
  const persona = oneOf(personaIds, 'Persona id.');
  const personaOrNone = oneOf([...personaIds, ''], 'Persona id, or "" for none.');
  const str = description => ({ type: 'string', ...(description ? { description } : {}) });
  const list = (props, description) => ({
    type: 'array', ...(description ? { description } : {}),
    items: { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props },
  });
  const line = {
    type: 'object',
    additionalProperties: false,
    required: ['speaker', 'text', 'emotion', 'gesture', 'shot', 'card'],
    properties: {
      speaker: pick(personaIds, 'Persona id of the anchor speaking this line.'),
      text: { type: 'string', description: 'What the anchor says, exactly as it should be spoken. One to three sentences.' },
      emotion: pick(EMOTIONS),
      gesture: pick(GESTURES),
      shot: pick(SHOTS, 'Camera shot; "auto" lets the director choose.'),
      card: { type: 'string', description: 'Id of the on-screen card to bring up when this line starts, or "" to leave the screen as it is.' },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'summary', 'tickerItems', 'segments', 'fanPoll', 'memoryUpdates'],
    properties: {
      title: { type: 'string', description: 'Episode title, under 60 characters.' },
      summary: { type: 'string', description: 'One or two sentences for the Discord announcement.' },
      tickerItems: { type: 'array', items: { type: 'string' }, description: '6 to 10 short ticker crawl items, under 60 characters each.' },
      segments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'lines'],
          properties: {
            id: { type: 'string', description: 'Segment id from the rundown, e.g. "s3".' },
            lines: { type: 'array', items: line },
          },
        },
      },
      fanPoll: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answers'],
        description: 'A Discord poll for viewers, posted with the episode. Leave question "" and answers [] when the brief asks for none.',
        properties: {
          question: { type: 'string', description: 'Under 120 characters, e.g. "Who won the Hot Take Hotline?"' },
          answers: {
            type: 'array',
            description: '2 to 4 answers, each under 50 characters.',
            items: {
              type: 'object', additionalProperties: false, required: ['text', 'persona'],
              properties: { text: { type: 'string' }, persona: oneOf([...personaIds, ''], 'The anchor whose side this answer is, or "".') },
            },
          },
        },
      },
      memoryUpdates: {
        type: 'object',
        additionalProperties: false,
        required: ['storylines', 'predictions', 'moods', 'relationships', 'arguments', 'caseFile'],
        properties: {
          storylines: list({
            key: str("An existing arc's key to add a beat to it, or a new short kebab-case key to open one."),
            title: str('The arc in a few words, e.g. "Can anyone stop the Bills?"'),
            beat: str('What happened to this arc tonight, in one sentence, from the facts.'),
            status: oneOf(ARC_STATUS),
            teams: { type: 'array', items: { type: 'string' }, description: 'Team abbreviations from the LEAGUE CONTEXT this arc follows.' },
            stakes: str('What is at stake, in one short sentence.'),
            nextBeat: str('What would move it next, e.g. "the Week 9 rematch".'),
            champion: oneOf([...personaIds, ''], 'The anchor who believes in it, or "".'),
            skeptic: oneOf([...personaIds, ''], 'The anchor who does not, or "".'),
          }, 'Every arc this episode opened or moved, one beat each.'),
          predictions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['persona', 'text', 'check'],
              properties: {
                persona,
                text: { type: 'string' },
                check: {
                  type: 'object', additionalProperties: false, required: ['kind', 'team', 'opponent', 'week', 'wins'],
                  description: 'How the show can grade it from final scores. "game": team beats opponent in that week. "wins": team wins at least that many regular-season games. "none": anything else. Unused fields: "" or 0.',
                  properties: {
                    kind: oneOf(['game', 'wins', 'none']),
                    team: str('Team abbreviation from the LEAGUE CONTEXT.'),
                    opponent: str('The other team\'s abbreviation, for "game".'),
                    week: { type: 'integer', description: 'The game\'s week number for "game" (Week 7 is 7; Wild Card 19, Divisional 20, Conference 21, Championship 23), or 0.' },
                    wins: { type: 'integer', description: 'The win total for "wins", or 0.' },
                  },
                },
              },
            },
          },
          moods: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['persona', 'mood'],
              properties: { persona, mood: { type: 'string' } },
            },
          },
          relationships: list({
            a: persona, b: persona,
            change: oneOf(REL_CHANGE),
            flashpoint: str('The moment tonight that moved it, in one sentence.'),
          }, 'Pairs whose relationship moved on air tonight.'),
          arguments: list({
            topic: str('What they argued about.'),
            winner: personaOrNone, loser: personaOrNone,
            decidedBy: oneOf(DECIDED_BY),
          }, 'Each real argument tonight. Thrown to the viewers: winner and loser "", decidedBy "viewers".'),
          caseFile: list({
            key: str("An existing case's key to add an exhibit, or a new short kebab-case key."),
            title: str('The theory, e.g. "The schedule makers hate the Bengals".'),
            evidence: str("Tonight's exhibit: a real fact from the facts, as Gus reads it."),
            status: oneOf(CASE_STATUS),
            believer: oneOf([...personaIds, ''], 'Anyone besides Gus who bought it tonight, or "".'),
          }, 'Cases Gus opened or added evidence to tonight.'),
        },
      },
    },
  };
}

// A schema node written out as a compact shape, for a model to follow by hand:
// { key: string (what it is), list: [ {...} ] }.
function shapeOf(node) {
  if (node.type === 'object') {
    return `{ ${Object.entries(node.properties).map(([k, v]) => `${k}: ${shapeOf(v)}`).join(', ')} }`;
  }
  if (node.type === 'array') return `[ ${shapeOf(node.items)} ]${node.description ? ` (${node.description})` : ''}`;
  return `${node.type}${node.description ? ` (${node.description})` : ''}`;
}

function scriptJsonSchema(personaIds, { lean = false, memoryAsText = false } = {}) {
  const schema = fullScriptSchema(personaIds, { lean });
  if (!memoryAsText) return schema;
  schema.properties.memoryUpdates = {
    type: 'string',
    description: `JSON text (an object, not wrapped in quotes or code fences) with exactly this shape: ${shapeOf(schema.properties.memoryUpdates)}. Use [] for any list with nothing to record.`,
  };
  return schema;
}

// The writer's half of memoryAsText: turn the JSON-text field back into an
// object. Anything unparseable becomes an empty update rather than failing
// the script, since the memory is extra and the show is not.
function parseMemoryUpdates(script) {
  if (!script || typeof script.memoryUpdates !== 'string') return { script, error: null };
  try {
    const value = JSON.parse(script.memoryUpdates.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) return { script: { ...script, memoryUpdates: value }, error: null };
    return { script: { ...script, memoryUpdates: {} }, error: 'memoryUpdates was not a JSON object' };
  } catch (e) {
    return { script: { ...script, memoryUpdates: {} }, error: `memoryUpdates was not valid JSON (${e.message})` };
  }
}

module.exports = { EMOTIONS, GESTURES, SHOTS, scriptJsonSchema, parseMemoryUpdates };
