import { toolDefinitionSchema, type ToolDefinition } from '@atlas-vnext/contracts';
import { ToolError, UnknownToolError } from './errors.ts';
import { assertObjectSchema } from './schema.ts';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): ToolDefinition {
    const parsed = toolDefinitionSchema.parse(definition);
    assertObjectSchema(parsed.inputSchema, `${parsed.id} inputSchema`);
    assertObjectSchema(parsed.outputSchema, `${parsed.id} outputSchema`);
    if (parsed.requiredCapabilities.length === 0) {
      throw new ToolError('malformed_tool', `Tool ${parsed.id} must declare Authority requirements.`, false);
    }
    this.tools.set(parsed.id, parsed);
    return parsed;
  }

  get(id: string): ToolDefinition {
    const found = this.tools.get(id);
    if (!found) throw new UnknownToolError(id);
    return found;
  }

  tryGet(id: string): ToolDefinition | null {
    return this.tools.get(id) ?? null;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  disable(id: string): void {
    this.tools.delete(id);
  }
}
