// The script contract shared by both writers (Claude and the offline template
// writer), the validator, the voice booth and the player.
//
// The JSON schema below is what Claude's structured output is constrained to.
// It only varies with the anchor lineup, so the request prefix stays cacheable
// from episode to episode. Segment ids and card ids are free strings here and
// are checked against the rundown by validate.js.
'use strict';

const EMOTIONS = ['neutral', 'happy', 'excited', 'angry', 'smug', 'shocked', 'sad', 'laughing', 'suspicious', 'serious'];
const GESTURES = ['none', 'point', 'shrug', 'desk_slam', 'facepalm', 'lean_in', 'thumbs_up', 'arms_crossed'];
const SHOTS = ['auto', 'wide', 'single', 'two_shot', 'graphic', 'full_graphic'];

function scriptJsonSchema(personaIds) {
  const persona = { type: 'string', enum: personaIds };
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
    required: ['title', 'summary', 'tickerItems', 'segments', 'memoryUpdates'],
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
      memoryUpdates: {
        type: 'object',
        additionalProperties: false,
        required: ['storylines', 'predictions', 'moods'],
        properties: {
          storylines: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['key', 'text'],
              properties: { key: { type: 'string' }, text: { type: 'string' } },
            },
          },
          predictions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['persona', 'text'],
              properties: { persona, text: { type: 'string' } },
            },
          },
          moods: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['persona', 'mood'],
              properties: { persona, mood: { type: 'string' } },
            },
          },
        },
      },
    },
  };
}

module.exports = { EMOTIONS, GESTURES, SHOTS, scriptJsonSchema };
