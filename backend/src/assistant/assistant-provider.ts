export const ASSISTANT_PROVIDER = Symbol('ASSISTANT_PROVIDER');

export interface AssistantProvider {
  selectTool(intent: string, tools: Readonly<Record<string, string>>): Promise<unknown>;
}
