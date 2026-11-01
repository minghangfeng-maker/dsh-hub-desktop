/**
 * A JSON Schema 2020-12 subset evaluator for the Hub manifest.
 *
 * The connector runs inside the desktop Host, whose module resolution reaches
 * only Node builtins: the profile installs this package as an unpacked archive
 * without a package manager, so a bare `import 'ajv'` cannot resolve. The
 * manifest schema therefore ships beside this module and this evaluator applies
 * it directly, which keeps one source of truth (`manifest.schema.json`, the
 * D3 contract the Hub renders against) instead of a second hand-written shape.
 *
 * Supported keywords are the ones that schema uses: `$ref` into `$defs`,
 * `type`, `const`, `enum`, `required`, `properties`, `additionalProperties`,
 * `items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `pattern`,
 * `minimum`, `maximum`, `oneOf`. `format` is deliberately ignored: annotation
 * only, and the semantic checks (revision ordering, artifact hashes, plugin
 * identity) belong to the caller, not to the schema.
 */

/** One schema node; the vocabulary is closed by the manifest schema itself. */
export type JsonSchemaNode = { readonly [keyword: string]: unknown }

/** One validation failure, addressed by a JSON Pointer for the status surface. */
export interface SchemaIssue {
  /** JSON Pointer of the offending value, empty for the document root. */
  readonly path: string
  /** Why the value was rejected, in operator-facing English. */
  readonly message: string
}

/** Stop after this many issues: a manifest is either acceptable or not, and a wall of text hides the first cause. */
const MAX_ISSUES = 20

/**
 * Resolve one local `$ref` (`#/$defs/name`) against the root schema.
 * @param root - Root schema document the reference is interpreted in.
 * @param reference - Reference string from the schema.
 * @returns The referenced node.
 * @throws {Error} When the reference is remote or names a missing definition.
 */
function resolveReference(root: JsonSchemaNode, reference: string): JsonSchemaNode {
  const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/u.exec(reference)
  if (match === null) throw new Error(`json-schema: unsupported reference ${JSON.stringify(reference)}`)
  const definitions = root.$defs
  if (typeof definitions !== 'object' || definitions === null) {
    throw new Error(`json-schema: schema declares no $defs for ${JSON.stringify(reference)}`)
  }
  const node = (definitions as Record<string, unknown>)[match[1] ?? '']
  if (typeof node !== 'object' || node === null) {
    throw new Error(`json-schema: missing definition ${JSON.stringify(reference)}`)
  }
  return node as JsonSchemaNode
}

/** Describe one value's JSON type for a diagnostic. */
function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Whether one value satisfies one `type` keyword. */
function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: throw new Error(`json-schema: unsupported type ${JSON.stringify(type)}`)
  }
}

/** Collect the members a schema declares required but the object omits. */
function missingMembers(schema: JsonSchemaNode, value: Record<string, unknown>): string[] {
  const required = schema.required
  if (!Array.isArray(required)) return []
  return required.filter(member => typeof member === 'string' && !Object.hasOwn(value, member))
}

/** Evaluate one node against one value, appending every failure. */
function evaluate(
  root: JsonSchemaNode,
  schema: JsonSchemaNode,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): void {
  if (issues.length >= MAX_ISSUES) return
  const reference = schema.$ref
  if (typeof reference === 'string') {
    evaluate(root, resolveReference(root, reference), value, path, issues)
    return
  }
  const at = path === '' ? '/' : path
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => matchesType(value, type))) {
      issues.push({ path: at, message: `expected ${types.join(' or ')}, received ${typeOf(value)}` })
      return
    }
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    issues.push({ path: at, message: `expected ${JSON.stringify(schema.const)}` })
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({ path: at, message: `expected one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}` })
    return
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push({ path: at, message: `must be >= ${String(schema.minimum)}` })
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push({ path: at, message: `must be <= ${String(schema.maximum)}` })
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) {
      issues.push({ path: at, message: `must be at least ${String(schema.minLength)} characters` })
    }
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) {
      issues.push({ path: at, message: `must be at most ${String(schema.maxLength)} characters` })
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      issues.push({ path: at, message: `must match ${schema.pattern}` })
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push({ path: at, message: `must hold at least ${String(schema.minItems)} items` })
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      issues.push({ path: at, message: `must hold at most ${String(schema.maxItems)} items` })
    }
    const items = schema.items
    if (typeof items === 'object' && items !== null) {
      value.forEach((entry, index) => {
        evaluate(root, items as JsonSchemaNode, entry, `${path}/${String(index)}`, issues)
      })
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const member of missingMembers(schema, record)) {
      issues.push({ path: at, message: `missing required member ${JSON.stringify(member)}` })
    }
    const properties = schema.properties
    const declared = typeof properties === 'object' && properties !== null
      ? properties as Record<string, unknown>
      : {}
    for (const [member, memberValue] of Object.entries(record)) {
      const memberSchema = declared[member]
      if (typeof memberSchema === 'object' && memberSchema !== null) {
        evaluate(root, memberSchema as JsonSchemaNode, memberValue, `${path}/${member}`, issues)
        continue
      }
      const additional = schema.additionalProperties
      if (additional === false) {
        issues.push({ path: `${path}/${member}`, message: 'unexpected member' })
      } else if (typeof additional === 'object' && additional !== null) {
        evaluate(root, additional as JsonSchemaNode, memberValue, `${path}/${member}`, issues)
      }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter((candidate) => {
      const probe: SchemaIssue[] = []
      evaluate(root, candidate as JsonSchemaNode, value, path, probe)
      return probe.length === 0
    })
    if (passing.length !== 1) {
      issues.push({ path: at, message: `must match exactly one of the alternatives, matched ${String(passing.length)}` })
    }
  }
}

/**
 * Validate one document against one schema.
 * @param schema - Root schema node (`manifest.schema.json` as parsed JSON).
 * @param value - Parsed document to validate.
 * @returns Every failure up to {@link MAX_ISSUES}; empty means the document conforms.
 */
export function validateSchema(schema: JsonSchemaNode, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  evaluate(schema, schema, value, '', issues)
  return issues
}
