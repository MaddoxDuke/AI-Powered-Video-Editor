import type { LLMTool } from './client'

export const proposeAnimationPlanTool: LLMTool = {
  name: 'propose_animation_plan',
  description: 'Output an animation plan with timestamped cues for the combined video.',
  schema: {
    type: 'object',
    required: ['cues', 'rationale'],
    properties: {
      rationale: { type: 'string' },
      cues: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'startInFinal', 'duration', 'kind', 'triggerText', 'variables', 'reason'],
          properties: {
            id: { type: 'string' },
            startInFinal: { type: 'number', description: 'Seconds into the final combined video.' },
            duration: { type: 'number', description: 'How long the animation plays (2–6 seconds).' },
            kind: { type: 'string', enum: ['lower-third', 'callout', 'kinetic-text', 'data-card'] },
            triggerText: { type: 'string', description: 'The spoken words that triggered this cue.' },
            variables: {
              type: 'object',
              description: 'Kind-specific template variables. lower-third: {title,subtitle?}. callout: {text,subtext?}. kinetic-text: {text}. data-card: {label,value,unit?}.',
              additionalProperties: { type: 'string' }
            },
            reason: { type: 'string' }
          }
        }
      }
    }
  }
}

export const proposeEDLTool: LLMTool = {
  name: 'propose_edl',
  description: 'Output a complete Edit Decision List for the video.',
  schema: {
    type: 'object',
    required: ['entries', 'rationale'],
    properties: {
      rationale: {
        type: 'string',
        description: '2-3 sentence summary of structural decisions — what was kept, cut, and how B-roll was placed. Be concise.'
      },
      chapters: {
        type: 'array',
        description: 'YouTube chapter markers. 4-8 chapters covering major topic transitions. First chapter must reference the very first A-roll entry (it will be placed at 0:00). Each chapter must be at least 10 seconds apart.',
        items: {
          type: 'object',
          required: ['title', 'aRollClipId', 'aRollStart'],
          properties: {
            title: { type: 'string', description: 'Short chapter title (2-5 words). e.g. "Installing intake manifold", "Wiring harness routing", "First start attempt".' },
            aRollClipId: { type: 'string', description: 'clipId of the A-roll entry where this chapter begins.' },
            aRollStart: { type: 'number', description: 'Approximate sourceStart time of the A-roll entry where this chapter begins.' }
          }
        }
      },
      entries: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              required: ['type', 'clipId', 'sourceStart', 'sourceEnd'],
              properties: {
                type: { type: 'string', enum: ['a-roll'] },
                clipId: { type: 'string', description: 'Filename without extension of the source A-roll clip.' },
                sourceStart: { type: 'number', description: 'Start time in seconds within the source clip.' },
                sourceEnd: { type: 'number', description: 'End time in seconds within the source clip.' }
              }
            },
            {
              type: 'object',
              required: ['type', 'clipId', 'sourceStart', 'sourceEnd', 'reason'],
              properties: {
                type: { type: 'string', enum: ['b-roll'] },
                clipId: { type: 'string', description: 'Filename without extension of the B-roll clip.' },
                sourceStart: { type: 'number', description: 'Start time in seconds within the B-roll clip.' },
                sourceEnd: { type: 'number', description: 'End time in seconds within the B-roll clip.' },
                reason: { type: 'string', description: 'One short phrase explaining why this B-roll is here.' },
                overUnderlying: {
                  type: 'object',
                  description: 'The A-roll segment playing underneath this B-roll overlay. Omit for standalone timelapse entries.',
                  required: ['aRollClipId', 'aRollStart', 'aRollEnd'],
                  properties: {
                    aRollClipId: { type: 'string' },
                    aRollStart: { type: 'number' },
                    aRollEnd: { type: 'number' }
                  }
                },
                timelapse: {
                  type: 'boolean',
                  description: 'If true, this clip plays standalone (not overlaid) at sped-up rate. Do not set overUnderlying.'
                },
                timelapseSpeed: {
                  type: 'number',
                  description: 'Speed multiplier for timelapse (e.g. 8 = 8×, 16 = 16×). Output will be capped at 8 seconds regardless. Choose based on source length: ~60s source → 8×, ~120s → 16×, ~300s → 32×.'
                },
                transition: {
                  type: 'boolean',
                  description: 'If true, this is a cinematic transition clip (lights on, door opening, etc). Output is capped at 4 seconds. Do not set overUnderlying.'
                },
                transitionTrim: {
                  type: 'string',
                  enum: ['start', 'middle', 'end'],
                  description: 'Which portion of the source clip to keep after applying the 4s cap. "start" = first 4s, "end" = last 4s, "middle" = center 4s. Choose based on the description: dark→bright clips use "end" (payoff is the lit state), closing/leaving clips use "start", ambiguous use "middle".'
                }
              }
            }
          ]
        }
      }
    }
  }
}
