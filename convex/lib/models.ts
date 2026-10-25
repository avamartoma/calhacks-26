// The models each program can run in the web office, by the name the program takes. The first
// choice, "", leaves it to the program's own default for that account.

export type Engine = "codex" | "claude" | "cursor";

export const MODELS: Record<Engine, { id: string; name: string }[]> = {
  claude: [
    { id: "", name: "Default" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  ],
  codex: [
    { id: "", name: "Default" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
  ],
  cursor: [
    { id: "", name: "Default" },
    { id: "composer-2.5", name: "Composer 2.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  ],
};

/** A model name safe to hand a program: one of its choices, or a plain name like those. "" is the default. */
export function checkModel(engine: Engine, model: string | undefined): string | undefined {
  const name = model?.trim() ?? "";
  if (!name) return undefined;
  if (MODELS[engine].some((choice) => choice.id === name) || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(name)) return name;
  throw new Error("That model name isn't one the agent can take");
}

export const modelName = (engine: Engine, model?: string | null) => (model ? MODELS[engine].find((choice) => choice.id === model)?.name ?? model : "Default model");
