import type { LLMTool } from './client'

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
                  description: 'The A-roll segment playing underneath this B-roll overlay.',
                  required: ['aRollClipId', 'aRollStart', 'aRollEnd'],
                  properties: {
                    aRollClipId: { type: 'string' },
                    aRollStart: { type: 'number' },
                    aRollEnd: { type: 'number' }
                  }
                }
              }
            }
          ]
        }
      }
    }
  }
}
