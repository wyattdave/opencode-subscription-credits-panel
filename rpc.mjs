import { Rpc } from '@opencode/plugin/rpc'

/**
 * The contract between the server plugin and its window bundle. Only normalized
 * usage and browser sign-in URLs leave this process: access and refresh tokens
 * never cross the RPC, nor do returned authorization codes or PKCE verifiers.
 */
export const Credits = Rpc.define(
  /** @type {const} */ ({
    id: 'opencode-credits-panel',
    events: {},
    methods: {
      codexLoginStart: {
        input: { type: 'object', additionalProperties: false },
        output: { type: 'object' },
      },
      codexLoginStatus: {
        input: { type: 'object', additionalProperties: false },
        output: { type: 'object' },
      },
      codexLoginCancel: {
        input: { type: 'object', additionalProperties: false },
        output: { type: 'object' },
      },
      snapshot: {
        input: { type: 'object', additionalProperties: false },
        output: { type: 'object' },
      },
      refresh: {
        input: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['codex', 'copilot', 'claude', 'go', 'cursor'] },
          },
          additionalProperties: false,
        },
        output: { type: 'object' },
      },
    },
  }),
)
