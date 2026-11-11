import { z } from 'zod'

type Json = Record<string, unknown>

/** keywords strict structured-output engines commonly reject; the same rules are enforced locally by zod after parsing */
const UNSUPPORTED = new Set(['pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'format', 'multipleOf', '$schema', 'default', 'examples', 'propertyNames', 'uniqueItems'])

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Convert a zod-generated JSON Schema into the shape strict `json_schema` mode requires:
 *  - every object lists ALL its properties as required and sets additionalProperties:false
 *  - properties that were optional become nullable (the model sends null, `stripNulls` removes it before zod parses)
 *  - oneOf becomes anyOf; validation keywords strict mode rejects are dropped (zod enforces them locally)
 * Pure and deterministic: the same input always produces byte-identical output (it is part of the cached prefix).
 */
export function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema)
  if (!isObj(node)) return node
  const out: Json = {}
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED.has(k)) continue
    if (k === 'oneOf') {
      out.anyOf = toStrictSchema(v)
      continue
    }
    if (k === 'properties' && isObj(v)) {
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
      const props: Json = {}
      for (const [pk, pv] of Object.entries(v)) {
        const converted = toStrictSchema(pv)
        props[pk] = required.has(pk) ? converted : { anyOf: [converted, { type: 'null' }] }
      }
      out.properties = props
      out.required = Object.keys(props)
      out.additionalProperties = false
      continue
    }
    if (k === 'required' || k === 'additionalProperties') continue
    out[k] = toStrictSchema(v)
  }
  if (out.type === 'object' && !('properties' in out)) {
    out.properties = {}
    out.required = []
    out.additionalProperties = false
  }
  return out
}

/** Remove `null` object members that only exist because strict mode forced optional fields to be nullable. */
export function stripNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripNulls) as T
  if (isObj(v)) {
    const out: Json = {}
    for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = stripNulls(x)
    return out as T
  }
  return v
}

export function strictJsonSchemaFor(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', reused: 'inline', cycles: 'throw' }) as Json
  return toStrictSchema(raw) as Json
}

/**
 * Compact TypeScript-like rendering of a zod schema, sent in the system prompt when the provider is used in plain JSON
 * mode (no response_format schema). Models cannot follow a contract they never see. Keys ending in `?` are optional.
 * Deterministic: it is part of the cached static prefix.
 */
export function compactSchemaFor(schema: z.ZodType): string {
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', reused: 'inline', cycles: 'throw' }) as Json
  const lit = (v: unknown) => JSON.stringify(v)
  const counts = new Map<string, number>()
  const aliases = new Map<string, string>()
  const defs: string[] = []
  let pass = 1
  /** returns [full text, text with repeated sub-shapes replaced by aliases] */
  const walk = (n: unknown): [string, string] => {
    const same = (t: string): [string, string] => [t, t]
    if (!isObj(n)) return same('any')
    if ('const' in n) return same(lit(n.const))
    if (Array.isArray(n.enum)) return same(n.enum.map(lit).join('|'))
    const alt = (n.anyOf ?? n.oneOf) as unknown[] | undefined
    if (Array.isArray(alt)) {
      const parts = alt.map(walk)
      return [[...new Set(parts.map((x) => x[0]))].join('|'), [...new Set(parts.map((x) => x[1]))].join('|')]
    }
    if (Array.isArray(n.type)) {
      const parts = n.type.map((t) => walk({ ...n, type: t }))
      return [[...new Set(parts.map((x) => x[0]))].join('|'), [...new Set(parts.map((x) => x[1]))].join('|')]
    }
    switch (n.type) {
      case 'object': {
        const props = isObj(n.properties) ? n.properties : {}
        const req = new Set(Array.isArray(n.required) ? (n.required as string[]) : [])
        const full: string[] = []
        const short: string[] = []
        for (const [k, v] of Object.entries(props)) {
          const [f, sh] = walk(v)
          full.push(`${k}${req.has(k) ? '' : '?'}:${f}`)
          short.push(`${k}${req.has(k) ? '' : '?'}:${sh}`)
        }
        if (isObj(n.additionalProperties)) {
          const [f, sh] = walk(n.additionalProperties)
          full.push(`[key:string]:${f}`)
          short.push(`[key:string]:${sh}`)
        } else if (n.additionalProperties === true && !full.length) return same('object')
        const f = `{${full.join(',')}}`
        let sh = `{${short.join(',')}}`
        if (pass === 1) counts.set(f, (counts.get(f) ?? 0) + 1)
        else if (f.length > 120 && (counts.get(f) ?? 0) >= 2) {
          let a = aliases.get(f)
          if (!a) {
            a = `T${aliases.size + 1}`
            aliases.set(f, a)
            defs.push(`${a} = ${sh}`)
          }
          sh = a
        }
        return [f, sh]
      }
      case 'array': {
        const [f, sh] = walk(n.items)
        const wrap = (t: string) => (t.includes('|') && !/^[{(]/.test(t) ? `(${t})[]` : /^[^{(]*\|/.test(t) ? `(${t})[]` : `${t}[]`)
        return [wrap(f), wrap(sh)]
      }
      case 'string':
        return same(typeof n.minLength === 'number' && n.minLength > 1 ? `string(min ${n.minLength} chars)` : 'string')
      case 'integer':
      case 'number':
        return same('number')
      case 'boolean':
        return same('boolean')
      case 'null':
        return same('null')
      default:
        return same('any')
    }
  }
  walk(raw)
  pass = 2
  const body = walk(raw)[1]
  return defs.length ? `${defs.join('\n')}\nRESPONSE = ${body}` : body
}

const prunable = new WeakMap<object, Json>()

/**
 * Drop keys the schema does not define on objects the schema declares closed. Models in plain JSON mode invent keys such as
 * `pipelineStageFieldId`; they carry no meaning for the CRM, and rejecting a whole design for them wastes a repair call.
 * Unions are pruned only when exactly one variant matches the discriminating constants (e.g. a patch op's `op`).
 * Returns the number of keys removed. Mutates `data`.
 */
export function pruneToSchema(data: unknown, schema: z.ZodType): number {
  let raw = prunable.get(schema)
  if (!raw) {
    raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', reused: 'inline', cycles: 'throw' }) as Json
    prunable.set(schema, raw)
  }
  let removed = 0
  const visit = (d: unknown, n: unknown): void => {
    if (!isObj(n)) return
    const alt = (n.anyOf ?? n.oneOf) as unknown[] | undefined
    if (Array.isArray(alt)) {
      if (!isObj(d)) {
        if (Array.isArray(d)) for (const v of alt) if (isObj(v) && v.type === 'array') return visit(d, v)
        return
      }
      const fits = alt.filter((v) => isObj(v) && isObj(v.properties) && Object.entries(v.properties).every(([k, p]) => !isObj(p) || !('const' in p) || d[k] === p.const) && Object.values(v.properties).some((p) => isObj(p) && 'const' in p))
      if (fits.length === 1) visit(d, fits[0])
      else if (alt.filter((v) => isObj(v) && v.type === 'object').length === 1) visit(d, alt.find((v) => isObj(v) && v.type === 'object'))
      return
    }
    if (n.type === 'array' && Array.isArray(d)) {
      for (const it of d) visit(it, n.items)
      return
    }
    if (n.type === 'object' && isObj(d) && isObj(n.properties)) {
      const props = n.properties
      if (n.additionalProperties === false) for (const k of Object.keys(d)) if (!(k in props)) (delete d[k], removed++)
      // a required list the model left out is an empty list
      if (Array.isArray(n.required)) for (const k of n.required as string[]) if (d[k] === undefined && isObj(props[k]) && props[k].type === 'array') (d[k] = []), removed++
      for (const [k, p] of Object.entries(props)) {
        if (!(k in d)) continue
        // an enum value that differs only in case, spacing or punctuation is the same value
        if (isObj(p) && Array.isArray(p.enum) && typeof d[k] === 'string' && !p.enum.includes(d[k])) {
          const norm = (x: unknown) => String(x).toLowerCase().replace(/[\s_\-]/g, '')
          const hit = p.enum.find((e) => norm(e) === norm(d[k]))
          if (hit !== undefined) d[k] = hit
        }
        // wrong primitive type with an obvious meaning: "true"/"yes" -> true, "12" -> 12, 12 -> "12"
        if (isObj(p)) {
          const v = d[k]
          if (p.type === 'object' && Array.isArray(v) && v.length === 1 && isObj(v[0])) d[k] = v[0]
          if (p.type === 'boolean' && typeof v === 'string') {
            const t = v.trim().toLowerCase()
            if (['true', 'yes', 'y', '1', 'on'].includes(t)) d[k] = true
            else if (['false', 'no', 'n', '0', 'off', ''].includes(t)) d[k] = false
          } else if (p.type === 'boolean' && typeof v === 'number') d[k] = v !== 0
          else if ((p.type === 'number' || p.type === 'integer') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) d[k] = Number(v)
          else if (p.type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) d[k] = String(v)
        }
        visit(d[k], p)
      }
    }
  }
  visit(data, raw)
  return removed
}
