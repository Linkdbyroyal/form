import { DashboardSpecificationSchema, WidgetTypeSchema, type DashboardSpecification, type WidgetType } from "@sbos/contracts";

/**
 * Specification gate for the dashboard renderer (M3-03). The renderer only ever receives a specification
 * that passed the contract; anything else becomes an error card. The widget whitelist is the contract's
 * `WidgetTypeSchema`, so an unknown type is refused here and never reaches a component.
 */
export type ParsedSpecification = { ok: true; spec: DashboardSpecification } | { ok: false; message: string; issues: string[] };

export const WIDGET_TYPES: readonly WidgetType[] = WidgetTypeSchema.options;

export function parseDashboardSpecification(input: unknown): ParsedSpecification {
  const result = DashboardSpecificationSchema.safeParse(input);
  if (result.success) return { ok: true, spec: result.data };
  const issues = result.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
  return { ok: false, message: "The stored dashboard specification does not satisfy the DashboardSpecification contract and is not rendered.", issues };
}

export function isWidgetType(value: string): value is WidgetType {
  return (WIDGET_TYPES as readonly string[]).includes(value);
}
