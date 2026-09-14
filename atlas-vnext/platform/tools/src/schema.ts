import { ToolValidationError } from './errors.ts';

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
}

export function assertObjectSchema(schema: unknown, label: string): JsonSchema {
  if (!isPlainObject(schema)) {
    throw new ToolValidationError(`Malformed ${label}: schema must be an object.`);
  }
  const type = schema.type;
  if (type !== undefined && type !== 'object' && !(Array.isArray(type) && type.includes('object'))) {
    throw new ToolValidationError(`Malformed ${label}: root schema type must be object.`);
  }
  return schema as JsonSchema;
}

export function validateAgainstSchema(schema: JsonSchema, value: unknown, path = '$'): void {
  if (schema.enum && !schema.enum.some((item) => stableEquals(item, value))) {
    throw new ToolValidationError(`Invalid ${path}: not in enum.`);
  }
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  if (types) {
    if (!types.some((type) => matchesType(type, value))) {
      throw new ToolValidationError(`Invalid ${path}: expected ${types.join('|')}.`);
    }
  }
  if (isPlainObject(value) && schema.properties) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) throw new ToolValidationError(`Invalid ${path}: missing ${required}.`);
    }
    for (const [key, child] of Object.entries(value)) {
      const prop = schema.properties[key];
      if (prop) validateAgainstSchema(prop, child, `${path}.${key}`);
      else if (schema.additionalProperties === false) {
        throw new ToolValidationError(`Invalid ${path}: unexpected property ${key}.`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validateAgainstSchema(schema.additionalProperties, child, `${path}.${key}`);
      }
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      throw new ToolValidationError(`Invalid ${path}: minLength.`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      throw new ToolValidationError(`Invalid ${path}: maxLength.`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) throw new ToolValidationError(`Invalid ${path}: minimum.`);
    if (schema.maximum != null && value > schema.maximum) throw new ToolValidationError(`Invalid ${path}: maximum.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      throw new ToolValidationError(`Invalid ${path}: minItems.`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      throw new ToolValidationError(`Invalid ${path}: maxItems.`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateAgainstSchema(schema.items!, item, `${path}[${index}]`));
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && (type === 'number' || Number.isInteger(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
