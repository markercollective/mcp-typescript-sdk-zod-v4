import { core, ZodErrorMap, ZodType, ZodTypeAny } from "zod/v4";

export enum McpZodTypeKind {
  Completable = "McpCompletable",
}

export type CompleteCallback<T extends ZodTypeAny = ZodTypeAny> = (
  value: T["_input"],
  context?: {
    arguments?: Record<string, string>;
  },
) => T["_input"][] | Promise<T["_input"][]>;

export interface CompletableDef<T extends ZodTypeAny = ZodTypeAny> {
  type: T;
  complete: CompleteCallback<T>;
  typeName: McpZodTypeKind.Completable;
}

export class Completable<T extends ZodTypeAny> {
  _def: CompletableDef<T>;

  constructor(def: CompletableDef<T>) {
    this._def = def;
  }

  parse(input: unknown): T["_output"] {
    // In Zod v4, delegate parsing to the wrapped type
    return this._def.type.parse(input);
  }

  unwrap() {
    return this._def.type;
  }

  static create = <T extends ZodTypeAny>(
    type: T,
    params: { complete: CompleteCallback<T> } & Record<string, unknown>,
  ): Completable<T> => {
    return new Completable({
      type,
      typeName: McpZodTypeKind.Completable,
      complete: params.complete,
      ...processCreateParams(params),
    });
  };
}

/**
 * Wraps a Zod type to provide autocompletion capabilities. Useful for, e.g., prompt arguments in MCP.
 */
export function completable<T extends ZodTypeAny>(
  schema: T,
  complete: CompleteCallback<T>,
): Completable<T> {
  return Completable.create(schema, { ...schema._def, complete });
}

// Simplified params processing for Zod v4
function processCreateParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!params) return {};
  const { errorMap, invalid_type_error, required_error, description, message } =
    params;
  if (errorMap && (invalid_type_error || required_error)) {
    throw new Error(
      `Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`,
    );
  }
  if (errorMap) return { errorMap: errorMap, description };
  const customMap: ZodErrorMap = (issue: core.$ZodRawIssue) => {
    if (issue.code === "invalid_value") {
      return {
        message: (message as string) ?? (issue.message || "Invalid value"),
      };
    }
    if (typeof issue.input === "undefined") {
      return {
        message: (message as string) ?? (required_error as string) ??
          (issue.message || "Required"),
      };
    }
    if (issue.code !== "invalid_type") {
      return { message: issue.message || "Invalid" };
    }
    return {
      message: (message as string) ?? (invalid_type_error as string) ??
        (issue.message || "Invalid type"),
    };
  };
  return { errorMap: customMap, description };
}
