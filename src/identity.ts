import type { Agent } from './types';

/** The overview names an agent by the work they own, not by a personal name. */
export function agentCharge(agent: { task?: string; title?: string; role?: string }, ticketTitle?: string) {
  const line = (ticketTitle || agent.task || agent.title || agent.role || 'Agent').split('\n')[0].trim();
  return (line || 'Agent').slice(0, 72);
}

export function agentLine(agent?: { name: string; title?: string } | null) {
  if (!agent) return 'Unassigned';
  return agent.title ? `${agent.name} · ${agent.title}` : agent.name;
}

export function modelLabel(model?: string) {
  if (!model) return 'No model assigned';
  if (model === 'Built-in') return 'Built-in';
  if (model === 'Account default') return model;
  const parts = model.split('-');
  if (parts[0].toLowerCase() === 'gpt' && parts.length >= 2) {
    const family = parts.slice(2).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    return family ? `GPT-${parts[1]} ${family}` : `GPT-${parts[1]}`;
  }
  return parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export function agentSpeech(agent: Pick<Agent, 'name' | 'title' | 'model' | 'effectiveModel' | 'status'>) {
  const who = agent.title ? `${agent.name}, ${agent.title}` : agent.name;
  if ((agent.effectiveModel || agent.model) === 'Built-in') return `${who}, built-in, ${agent.status}`;
  return `${who}, running ${modelLabel(agent.effectiveModel || agent.model)}, status: ${agent.status}`;
}
