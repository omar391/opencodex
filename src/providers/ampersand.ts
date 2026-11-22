/**
 * Ampersand models (developed by humans&, e.g. `humansand/ampersand-v0.1`).
 *
 * Ampersand is an agentic collaboration model fine-tuned on GLM-5.3. It supports `tool_choice: "auto"`
 * and `tool_choice: "none"`, but rejects or behaves inconsistently with forced/named tool constraints
 * (such as `"required"`), causing the model to emit unoffered tool calls or fail validation upstream.
 */
export function isAmpersandModel(modelId: string | undefined): boolean {
  if (typeof modelId !== "string") return false;
  const id = modelId.trim().toLowerCase();
  return (
    id === "ampersand"
    || id.startsWith("ampersand-")
    || id.startsWith("ampersand/")
    || id.startsWith("humansand/")
    || id.includes("/ampersand")
  );
}
