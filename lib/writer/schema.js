// The script contract shared by both writers (Claude and the offline template
// writer), the validator, the voice booth and the player.
//
// The JSON schema below is what Claude's structured output is constrained to.
// It only varies with the anchor lineup, so the request prefix stays cacheable
// from episode to episode. Segment ids and card ids are free strings here and
// are checked against the rundown by validate.js.
'use strict';
const { ARC_STATUS, CASE_STATUS, REL_CHANGE, DECIDED_BY } = require('../memory');

const EMOTIONS = ['neutral', 'happy', 'excited', 'angry', 'smug', 'shocked', 'sad', 'laughing', 'suspicious', 'serious'];
const GESTURES = ['none', 'point', 'shrug', 'desk_slam', 'facepalm', 'lean_in', 'thumbs_up', 'arms_crossed'];
const SHOTS = ['auto', 'wide', 'single', 'two_shot', 'graphic', 'full_graphic'];

function scriptJsonSchema(personaIds) {
  const persona = { type: 'string', enum: personaIds };
  const personaOrNone = { type: 'string', enum: [...personaIds, ''] };
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
      speaker: { ...persona, description: 'Persona id of the anchor speaking this line.' },
      text: { type: 'string', description: 'What the anchor says, exactly as it should be spoken. One to three sentences.' },
      emotion: { type: 'string', enum: EMOTIONS },
      gesture: { type: 'string', enum: GESTURES },
      shot: { type: 'string', enum: SHOTS, description: 'Camera shot; "auto" lets the director choose.' },
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
              properties: { text: { type: 'string' }, persona: { type: 'string', enum: [...personaIds, ''], description: 'The anchor whose side this answer is, or "".' } },
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
            status: { type: 'string', enum: ARC_STATUS },
            teams: { type: 'array', items: { type: 'string' }, description: 'Team abbreviations from the LEAGUE CONTEXT this arc follows.' },
            stakes: str('What is at stake, in one short sentence.'),
            nextBeat: str('What would move it next, e.g. "the Week 9 rematch".'),
            champion: { ...personaOrNone, description: 'The anchor who believes in it.' },
            skeptic: { ...personaOrNone, description: "The anchor who doesn't." },
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
                    kind: { type: 'string', enum: ['game', 'wins', 'none'] },
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
            change: { type: 'string', enum: REL_CHANGE },
            flashpoint: str('The moment tonight that moved it, in one sentence.'),
          }, 'Pairs whose relationship moved on air tonight.'),
          arguments: list({
            topic: str('What they argued about.'),
            winner: personaOrNone, loser: personaOrNone,
            decidedBy: { type: 'string', enum: DECIDED_BY },
          }, 'Each real argument tonight. Thrown to the viewers: winner and loser "", decidedBy "viewers".'),
          caseFile: list({
            key: str("An existing case's key to add an exhibit, or a new short kebab-case key."),
            title: str('The theory, e.g. "The schedule makers hate the Bengals".'),
            evidence: str("Tonight's exhibit: a real fact from the facts, as Gus reads it."),
            status: { type: 'string', enum: CASE_STATUS },
            believer: { ...personaOrNone, description: 'Anyone besides Gus who bought it tonight.' },
          }, 'Cases Gus opened or added evidence to tonight.'),
        },
      },
    },
  };
}

module.exports = { EMOTIONS, GESTURES, SHOTS, scriptJsonSchema };
