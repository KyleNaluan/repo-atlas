/**
 * Library surface.
 *
 * #3 makes `atlas.json` the contract and the rendered HTML one view of it, which
 * is what keeps the interview-prep tool a separate consumer. That consumer needs
 * the types and the validator, and nothing else here.
 */
export * from "./schema/types.js";
export {
  loadAtlas,
  validateAtlas,
  schemaDocument,
  AtlasValidationError,
} from "./schema/validate.js";
export { version } from "./version.js";
