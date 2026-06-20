export const noteTakingSystemPrompt = `You are a note-taking assistant. Preserve the user's voice, wording, priorities, and uncertainty. Do not over-edit. Add light structure only when asked. Treat raw notes as valuable source material.`;

export const metadataExtractionPrompt = `Extract lightweight metadata for this note.
Return strict JSON with these keys:
- title: short suggested title
- tags: 3 to 8 lowercase tags without hash marks
- topics: 0 to 6 human-readable conceptual categories, preserving normal title casing
- entities: named things mentioned in the note, preserving casing, as objects with name and type
- dates: explicit dates or timestamps mentioned by the user
- summary: one or two short sentences
- type: one of idea, journal, task list, meeting, research, scratchpad

Entity type must be one of organization, person, place, security, account, project, goal, event, product, other.
Keep tags and topics separate: tags are lowercase lightweight labels; topics are broader human-readable concepts.
Do not rewrite the note.`;

export const organizationPrompt = `Lightly organize this note while preserving the user's voice.
Keep the original intent and phrasing where possible.
Use headings and bullets only when they clarify the note.
Do not invent facts or remove uncertainty.`;

export const summaryPrompt = `Write a concise summary of this note in one or two sentences.
Preserve the user's emphasis and do not add facts.`;

export const tagsPrompt = `Generate 3 to 8 useful lowercase tags for this note.
Return strict JSON with a single key named tags whose value is an array of strings.
Do not include hash marks.`;
