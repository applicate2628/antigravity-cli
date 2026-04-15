// Antigravity Auth Constants
// Local replacement for the missing 'opencode-antigravity-auth' package

/**
 * System instruction sent alongside AI model requests.
 * Provides baseline behavioral guidance for the model.
 */
export const ANTIGRAVITY_SYSTEM_INSTRUCTION = 'You are a helpful AI coding assistant. Respond clearly and concisely. When providing code, ensure it is correct, well-structured, and follows best practices.';

/**
 * Returns HTTP headers required by the Cloud Code / Gemini Code Assist API.
 * These headers identify the client to the Google API gateway.
 */
export function getAntigravityHeaders() {
    return {
        'x-goog-api-client': 'gl-node genai-node/0.24.1 antigravity-cli/1.0.0',
        'User-Agent': 'antigravity-cli/1.0.0 (Node.js; Gemini Code Assist)',
        'x-server-timeout': '300',
    };
}
