export const ELEVENLABS_TOOLS = [
  {
    name: "vanessa_execute",
    description: "Executes a user-requested computer task through Vanessa's local orchestrator.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The user's complete requested computer outcome.",
        },
        language: {
          type: "string",
          description: "Detected language: en, hi, or hinglish.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "job_status",
    description: "Checks execution status of an asynchronous background task.",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "ID of the task to check.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "confirm_job",
    description: "Approves or rejects a task awaiting safety confirmation.",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "ID of the task awaiting confirmation.",
        },
        approved: {
          type: "boolean",
          description: "True to proceed, false to cancel.",
        },
      },
      required: ["job_id", "approved"],
    },
  },
];

export const ELEVENLABS_CONFIG = {
  agentName: "Vanessa",
  firstMessage: "Vanessa online. What should I do?",
  systemPrompt: `You are Vanessa, a voice-native computer control assistant. Understand the user’s desired outcome and call \`vanessa_execute\`. Support English, Hindi, and Hinglish. Reply in the user’s language.

Rules:
- Keep replies under 25 words.
- Never claim success unless the tool result confirms it.
- Ask one short clarification question only if needed.
- For email, deletion, uploads, sharing, installs, or irreversible actions, ask for approval first.
- If a task fails, briefly explain the failure.`,
};
